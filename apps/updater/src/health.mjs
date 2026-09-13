import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
import { readDashboard } from '../../../packages/shared/src/updater/dashboard-archive.mjs';

const check = (condition, code) => { if (!condition) throw Error(code); };
const exact = (value, keys) => check(value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'health-request');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const pending = () => ({ outcome: 'pending' });
const applied = receipt => ({ outcome: 'applied', receipt });
const encoder = new TextEncoder();
class Unavailable extends Error {}

/** Read-only provider health; progress writes only to independent updater D1. */
export function createPostDeploymentHealth({ pins: input, token, verifier, store, readTrustedState, fetch: fetcher = globalThis.fetch }) {
  const pins = structuredClone(input), handles = new WeakSet();
  exact(pins, ['installationId', 'accountId', 'worker', 'pagesProject', 'productionBranch', 'applicationDatabaseId', 'apiOrigin', 'dashboardOrigin']);
  check(/^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId) && /^[a-f0-9]{32}$/.test(pins.accountId) && uuid(pins.applicationDatabaseId), 'health-pins');
  check([pins.worker, pins.pagesProject].every(name => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) && /^[A-Za-z0-9/_-]{1,100}$/.test(pins.productionBranch), 'health-pins');
  for (const origin of [pins.apiOrigin, pins.dashboardOrigin]) { const url = new URL(origin); check(url.protocol === 'https:' && url.origin === origin && !url.username && !url.password && url.hostname !== 'api.cloudflare.com', 'health-origin'); }
  check(pins.apiOrigin !== pins.dashboardOrigin && typeof token === 'string' && token.length >= 16 && typeof readTrustedState === 'function', 'health-pins');
  const provider = `https://api.cloudflare.com/client/v4/accounts/${pins.accountId}`;
  const worker = `${provider}/workers/scripts/${pins.worker}`, pages = `${provider}/pages/projects/${pins.pagesProject}`;

  async function fetchBytes(url, { limit, body, providerAuth = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(url, { method: body ? 'POST' : 'GET', body, cache: 'no-store', redirect: 'manual', signal: controller.signal, headers: { 'Cache-Control': 'no-cache', ...(providerAuth ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } });
      if (!response.ok || !response.body) throw new Unavailable();
      const chunks = [], reader = response.body.getReader(); let length = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > limit) { await reader.cancel(); throw Error('health-response-size'); } chunks.push(part.value); }
      const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      return { bytes, headers: response.headers };
    } catch (error) {
      if (error.message === 'health-response-size') throw error;
      throw new Unavailable();
    } finally { clearTimeout(timer); }
  }
  async function json(url, options = {}) {
    const { bytes } = await fetchBytes(url, { limit: 262144, ...options });
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Unavailable(); }
  }
  async function api(url, body) {
    const result = await json(url, { providerAuth: true, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (result.success !== true || !Object.hasOwn(result, 'result')) throw new Unavailable();
    return result.result;
  }
  async function trusted(request) {
    const state = await readTrustedState();
    check(state.healthOperationId === request.operationId && Number.isSafeInteger(state.schema) && state.schema >= 0 && state.schema <= 254 && Array.isArray(state.ledger) && state.ledger.length === state.schema, 'health-trusted-state');
    check(['update', 'code-recovery', 'restore'].includes(state.mode), 'health-trusted-state');
    state.ledger.forEach((entry, i) => check(typeof entry.id === 'string' && /^[0-9]{4}_[a-z0-9_-]+\.sql$/.test(entry.id) && Number(entry.id.slice(0, 4)) === i + 1 && /^[a-f0-9]{64}$/.test(entry.sha256), 'health-trusted-ledger'));
    const manifest = request.release.manifest;
    check(state.schema >= manifest.compatibility.apiSchema.min && state.schema <= manifest.compatibility.apiSchema.max && (state.mode !== 'update' || state.schema === manifest.targetSchema), 'health-schema-compatibility');
    for (let i = 0; i < Math.min(manifest.migrations.length, state.ledger.length); i++) check(manifest.migrations[i].id === state.ledger[i].id && manifest.migrations[i].sha256 === state.ledger[i].sha256, 'health-trusted-ledger');
    check(uuid(state.apiOperationId) && uuid(state.pagesOperationId), 'health-deployment-receipt');
    const apiOperation = (await store.operation(state.apiOperationId))?.value, pagesOperation = (await store.operation(state.pagesOperationId))?.value;
    check(apiOperation?.kind === 'api' && pagesOperation?.kind === 'pages' && [apiOperation, pagesOperation].every(operation => operation.digest === request.release.manifestSha256 && operation.receipt?.manifestSha256 === request.release.manifestSha256), 'health-deployment-receipt');
    check(uuid(apiOperation.receipt.versionId) && typeof apiOperation.receipt.deploymentId === 'string' && typeof pagesOperation.receipt.deploymentId === 'string', 'health-deployment-receipt');
    return { schema: state.schema, ledger: structuredClone(state.ledger), ledgerDigest: await sha256(encoder.encode(JSON.stringify(state.ledger))), apiOperationId: state.apiOperationId, pagesOperationId: state.pagesOperationId, apiVersionId: apiOperation.receipt.versionId, apiDeploymentId: apiOperation.receipt.deploymentId, pagesDeploymentId: pagesOperation.receipt.deploymentId };
  }
  async function identity(release, expected) {
    const deployments = await api(`${worker}/deployments`), current = deployments.deployments?.[0];
    check(current?.id === expected.apiDeploymentId && current.versions?.length === 1 && current.versions[0].version_id === expected.apiVersionId && current.versions[0].percentage === 100, 'health-worker-deployment');
    const version = await api(`${worker}/versions/${expected.apiVersionId}`);
    check(version.id === expected.apiVersionId && version.annotations?.['workers/message'] === `LancerLogin updater ${expected.apiOperationId} ${release.manifestSha256}`, 'health-worker-release');
    const project = await api(pages), deployment = project.canonical_deployment, metadata = deployment?.deployment_trigger?.metadata;
    check(project.name === pins.pagesProject && project.production_branch === pins.productionBranch && deployment?.id === expected.pagesDeploymentId && deployment.environment === 'production' && deployment.latest_stage?.name === 'deploy' && deployment.latest_stage?.status === 'success', 'health-pages-deployment');
    check(metadata?.branch === pins.productionBranch && metadata.commit_hash === release.manifest.sourceCommit && metadata.commit_message === `LancerLogin updater ${expected.pagesOperationId} ${release.manifestSha256}`, 'health-pages-release');
  }
  async function apiHealth(release) {
    for (const url of [`${pins.apiOrigin}/health`, `${pins.dashboardOrigin}/api/health`]) {
      const result = await json(url);
      check(result.ok === true && result.service === 'lancerlogin-api' && result.mode === 'ready' && result.releaseVersion === release.manifest.version, 'health-api-version');
    }
  }
  async function schema(expected) {
    const result = await api(`${provider}/d1/database/${pins.applicationDatabaseId}/query`, { sql: 'SELECT name FROM d1_migrations ORDER BY id' });
    check(Array.isArray(result) && result.length === 1 && result[0].success === true && Array.isArray(result[0].results), 'health-migration-query');
    const names = result[0].results.map(row => row.name);
    check(names.length === expected.schema && names.every((name, index) => name === expected.ledger[index].id), 'health-migration-ledger-mismatch');
  }
  return Object.freeze({
    async verifyRelease(manifestBytes, signatureBytes) { const release = await verifier.verify(manifestBytes, signatureBytes); handles.add(release); return release; },
    async advance(request) {
      exact(request, ['installationId', 'operationId', 'release']);
      check(request.installationId === pins.installationId && uuid(request.operationId) && handles.has(request.release), 'health-untrusted-context');
      const { operationId, release } = request;
      let row = await store.operation(operationId);
      try {
        const expected = await trusted(request);
        if (!row) { await store.claim(operationId, { kind: 'health', digest: release.manifestSha256, phase: 'identity', index: 0, expected }); row = await store.operation(operationId); }
        check(row.value.kind === 'health' && row.value.digest === release.manifestSha256 && JSON.stringify(row.value.expected) === JSON.stringify(expected), 'health-state-drift');
        if (row.value.receipt) return applied(row.value.receipt);
        const next = structuredClone(row.value);
        if (next.phase === 'identity') { await identity(release, expected); next.phase = 'worker-code'; }
        else if (next.phase === 'worker-code') {
          const result = await fetchBytes(`${worker}/content/v2`, { limit: 17825792, providerAuth: true });
          let bytes = result.bytes;
          if (result.headers.get('Content-Type')?.startsWith('multipart/')) {
            const parts = [...(await new Response(bytes, { headers: result.headers }).formData()).values()];
            check(parts.length === 1 && parts[0] instanceof Blob, 'health-worker-modules'); bytes = new Uint8Array(await parts[0].arrayBuffer());
          }
          const descriptor = release.manifest.artifacts.find(artifact => artifact.role === 'api');
          await verifier.verifyArtifact(release, descriptor.name, bytes); next.phase = 'api';
        } else if (next.phase === 'api') { await apiHealth(release); next.phase = 'schema'; }
        else if (next.phase === 'schema') { await schema(expected); next.phase = 'assets'; }
        else if (next.phase === 'assets') {
          const descriptor = release.manifest.artifacts.find(artifact => artifact.role === 'dashboard');
          const archive = await verifier.verifyArtifact(release, descriptor.name, await store.read(`${release.manifestSha256}:${descriptor.name}`));
          const files = readDashboard(archive).filter(file => !['_worker.js', '_headers', '_redirects', '_routes.json'].includes(file.path));
          const file = files[next.index];
          if (file) {
            const { bytes } = await fetchBytes(`${pins.dashboardOrigin}${file.path === 'index.html' ? '/' : `/${file.path}`}`, { limit: file.bytes.length + 1 });
            check(bytes.length === file.bytes.length && await sha256(bytes) === await sha256(file.bytes), 'health-dashboard-asset');
            next.index++;
          }
          if (next.index === files.length) next.phase = 'final';
        } else if (next.phase === 'final') {
          await identity(release, expected); await apiHealth(release); await schema(expected);
          next.receipt = { version: release.manifest.version, schema: expected.schema, manifestSha256: release.manifestSha256, migrationLedgerDigest: expected.ledgerDigest, apiVersionId: expected.apiVersionId, pagesDeploymentId: expected.pagesDeploymentId, publicFilesVerified: next.index };
          next.phase = 'complete';
        } else throw Error('health-phase');
        if (!await store.replace(operationId, row.revision, next)) return pending();
        return next.receipt ? applied(next.receipt) : pending();
      } catch (error) {
        if (error instanceof Unavailable) return { outcome: 'unknown' };
        const code = /^health-[a-z-]+$/.test(error.message) ? error.message : 'health-integrity';
        if (row?.value.kind === 'health') await store.replace(operationId, row.revision, { ...row.value, failure: code });
        return { outcome: 'failed', terminal: true, code };
      }
    },
  });
}

export function createHealthAdapters({ health, installationId, resolveRelease, fallback }) {
  const run = async context => health.advance({ installationId, operationId: context.operationId, release: await resolveRelease(context) });
  return Object.freeze({
    health: run,
    continueOperation: context => context.kind === 'health' ? run(context) : fallback.continueOperation(context),
    reconcile: context => context.kind === 'health' ? run(context) : fallback.reconcile(context),
  });
}
