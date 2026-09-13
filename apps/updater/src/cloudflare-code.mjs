import { sha256 } from '../../../packages/shared/src/updater/application-release.mjs';
import { readDashboard } from '../../../packages/shared/src/updater/dashboard-archive.mjs';
import { toBase64 } from './checkpoint.mjs';
import { ARTIFACT_CHUNK_BYTES } from './artifact-store.mjs';

const check = (value, code) => { if (!value) throw Error(code); };
const encoder = new TextEncoder();
const unknown = () => ({ outcome: 'unknown' });
const pending = () => ({ outcome: 'pending' });
const applied = receipt => ({ outcome: 'applied', receipt });
const exact = (value, keys) => check(value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'request');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const descriptor = (release, role) => release.manifest.artifacts.find(artifact => artifact.role === role);
const artifactId = (release, name) => `${release.manifestSha256}:${name}`;

// Pages uses BLAKE3(base64(file) + extension), truncated to 128 bits (Wrangler
// 4.127.1 src/pages/hash.ts). Standard BLAKE3 compression, no Node/WASM imports.
const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
function compress(cv, block, counter, length, flags) {
  const v = new Uint32Array([...cv, ...IV.slice(0, 4), counter >>> 0, Math.floor(counter / 4294967296), length, flags]);
  let m = block;
  const g = (a, b, c, d, x, y) => {
    v[a] = v[a] + v[b] + x; v[d] = rotate(v[d] ^ v[a], 16); v[c] += v[d]; v[b] = rotate(v[b] ^ v[c], 12);
    v[a] = v[a] + v[b] + y; v[d] = rotate(v[d] ^ v[a], 8); v[c] += v[d]; v[b] = rotate(v[b] ^ v[c], 7);
  };
  for (let round = 0; round < 7; round++) {
    g(0, 4, 8, 12, m[0], m[1]); g(1, 5, 9, 13, m[2], m[3]); g(2, 6, 10, 14, m[4], m[5]); g(3, 7, 11, 15, m[6], m[7]);
    g(0, 5, 10, 15, m[8], m[9]); g(1, 6, 11, 12, m[10], m[11]); g(2, 7, 8, 13, m[12], m[13]); g(3, 4, 9, 14, m[14], m[15]);
    m = PERM.map(index => m[index]);
  }
  return Uint32Array.from({ length: 16 }, (_, i) => i < 8 ? v[i] ^ v[i + 8] : v[i] ^ cv[i - 8]);
}
export function pagesAssetHash(bytes, path) {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : '';
  const input = encoder.encode(toBase64(bytes) + extension), stack = [];
  const cvOf = output => compress(...output).slice(0, 8);
  const parent = (left, right) => [IV, new Uint32Array([...left, ...right]), 0, 64, 4];
  let output;
  for (let start = 0, chunk = 0; start < Math.max(input.length, 1); start += 1024, chunk++) {
    let cv = IV;
    const length = Math.min(1024, input.length - start);
    for (let offset = 0; offset < Math.max(length, 1); offset += 64) {
      const count = Math.min(64, length - offset), words = new Uint32Array(16);
      for (let i = 0; i < count; i++) words[i >>> 2] |= input[start + offset + i] << ((i & 3) * 8);
      output = [cv, words, chunk, count, (offset === 0 ? 1 : 0) | (offset + 64 >= length ? 2 : 0)];
      if (offset + 64 < length) cv = cvOf(output);
    }
    if (start + 1024 < input.length) {
      let chain = cvOf(output), total = chunk + 1;
      while ((total & 1) === 0) { chain = cvOf(parent(stack.pop(), chain)); total >>>= 1; }
      stack.push(chain);
    }
  }
  while (stack.length) output = parent(stack.pop(), cvOf(output));
  output[4] |= 8;
  const result = compress(...output), resultBytes = new Uint8Array(16);
  const view = new DataView(resultBytes.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, result[i], true);
  return [...resultBytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createCloudflareCodeTransport({ pins: suppliedPins, token, verifier, store, fetch: fetcher = globalThis.fetch }) {
  const pins = structuredClone(suppliedPins);
  exact(pins, ['installationId', 'accountId', 'worker', 'pagesProject', 'productionBranch', 'applicationDatabaseId', 'workerSettings', 'nonsecretBindings']);
  check(/^[a-f0-9]{32}$/.test(pins.accountId) && uuid(pins.applicationDatabaseId) && /^[A-Za-z0-9_-]{1,80}$/.test(pins.installationId), 'pins');
  check([pins.worker, pins.pagesProject].every(name => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) && /^[A-Za-z0-9/_-]{1,100}$/.test(pins.productionBranch), 'pins');
  check(typeof token === 'string' && token.length >= 16 && Array.isArray(pins.nonsecretBindings), 'pins');
  check(pins.nonsecretBindings.every(binding => binding.name && !['secret_text', 'secret_key'].includes(binding.type) && (binding.type !== 'd1' || binding.id === pins.applicationDatabaseId)), 'bindings');
  check(pins.nonsecretBindings.filter(binding => binding.name === 'RELEASE_VERSION' && binding.type === 'plain_text').length === 1, 'release-version-binding');
  const configurationKeys = ['compatibility_date', 'compatibility_flags', 'usage_model', 'logpush', 'tail_consumers', 'observability', 'placement', 'limits', 'tags'];
  check(Object.keys(pins.workerSettings).every(key => configurationKeys.includes(key)), 'worker-settings');
  const own = new WeakSet();
  const workerPath = `/accounts/${pins.accountId}/workers/scripts/${pins.worker}`;
  const pagesPath = `/accounts/${pins.accountId}/pages/projects/${pins.pagesProject}`;
  const guard = (request, keys) => {
    exact(request, keys);
    check(request.installationId === pins.installationId && own.has(request.release), 'untrusted-context');
    if (keys.includes('operationId')) check(uuid(request.operationId), 'operation-id');
  };
  async function request(path, { method = 'GET', body, jwt, binary = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { method, body, headers: { Authorization: `Bearer ${jwt ?? token}`, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'manual', signal: controller.signal });
      check(response.status < 300 || response.status >= 400, 'provider-redirect');
      const reader = response.body?.getReader(), chunks = []; let length = 0;
      check(reader, 'provider-response');
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > (binary ? 17825792 : 1048576)) { await reader.cancel(); throw Error('provider-size'); } chunks.push(part.value); }
      const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      check(response.ok, 'provider-rejected');
      if (binary) return new Response(bytes, { headers: response.headers });
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      check(value.success === true && Object.hasOwn(value, 'result'), 'provider-response');
      return value.result;
    } finally { clearTimeout(timer); }
  }
  const marker = (id, release) => `LancerLogin updater ${id} ${release.manifestSha256}`;
  const bindingsFor = release => pins.nonsecretBindings.map(binding => binding.name === 'RELEASE_VERSION' ? { ...binding, text: release.manifest.version } : binding);
  async function inspectWorker(release) {
    const settings = await request(`${workerPath}/settings`);
    check(Array.isArray(settings.bindings), 'worker-settings');
    const nonsecret = settings.bindings.filter(binding => !['secret_text', 'secret_key'].includes(binding.type));
    const order = bindings => [...bindings].sort((a, b) => a.name.localeCompare(b.name));
    check(canonical(order(nonsecret)) === canonical(order(bindingsFor(release))), 'binding-drift');
    for (const [key, value] of Object.entries(pins.workerSettings)) check(canonical(settings[key]) === canonical(value), 'configuration-drift');
    for (const key of configurationKeys) check(!Object.hasOwn(settings, key) || Object.hasOwn(pins.workerSettings, key), 'configuration-unpinned');
    return settings;
  }
  async function inspectPages() {
    const project = await request(pagesPath);
    check(project.name === pins.pagesProject && project.production_branch === pins.productionBranch && !project.source && project.deployment_configs?.production, 'pages-pins');
    return project;
  }
  async function operation(requestValue, kind) {
    const { operationId, release } = requestValue;
    const row = await store.operation(operationId);
    if (!row) { await store.claim(operationId, { kind, digest: release.manifestSha256, phase: 'prepare', index: 0 }); return operation(requestValue, kind); }
    check(row.value.kind === kind && row.value.digest === release.manifestSha256, 'operation-conflict');
    return row;
  }
  async function set(operationId, row, changes) { return store.replace(operationId, row.revision, { ...row.value, ...changes }); }
  async function reconcileApi(requestValue) {
    const { operationId, release } = requestValue;
    const versions = await request(`${workerPath}/versions?page=1&per_page=100`);
    check(Array.isArray(versions.items), 'versions');
    const matches = versions.items.filter(version => version.annotations?.['workers/message'] === marker(operationId, release));
    if (matches.length !== 1 || !uuid(matches[0].id)) return unknown();
    const deployments = await request(`${workerPath}/deployments`);
    const latest = deployments.deployments?.[0];
    if (latest?.versions?.length !== 1 || latest.versions[0].version_id !== matches[0].id || latest.versions[0].percentage !== 100) return unknown();
    const settings = await inspectWorker(release), saved = await store.operation(operationId);
    check(canonical(settings.bindings.filter(binding => ['secret_text', 'secret_key'].includes(binding.type)).map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name))) === saved.value.secrets, 'secret-inventory-drift');
    return applied({ manifestSha256: release.manifestSha256, versionId: matches[0].id, deploymentId: latest.id });
  }
  async function pagesFiles(release) {
    const artifact = descriptor(release, 'dashboard');
    const bytes = await verifier.verifyArtifact(release, artifact.name, await store.read(artifactId(release, artifact.name)));
    return readDashboard(bytes);
  }
  const special = name => ['_worker.js', '_headers', '_redirects', '_routes.json'].includes(name);
  const contentType = path => ({ html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'application/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon', woff2: 'font/woff2', txt: 'text/plain; charset=utf-8' }[path.split('.').at(-1)] ?? 'application/octet-stream');
  async function reconcilePages(requestValue, row) {
    const { operationId, release } = requestValue;
    if (row.value.phase === 'asset-dispatched') {
      const files = (await pagesFiles(release)).filter(file => !special(file.path)), file = files[row.value.index];
      const hash = pagesAssetHash(file.bytes, file.path), { jwt } = await request(`${pagesPath}/upload-token`);
      check(typeof jwt === 'string', 'upload-token');
      const missing = await request('/pages/assets/check-missing', { method: 'POST', jwt, body: JSON.stringify({ hashes: [hash] }) });
      if (!Array.isArray(missing) || missing.length !== 0) return unknown();
      await set(operationId, row, { phase: 'prepare', index: row.value.index + 1 });
      return pending();
    }
    const deployments = await request(`${pagesPath}/deployments?page=1&per_page=100`);
    check(Array.isArray(deployments), 'pages-deployments');
    const matches = deployments.filter(deployment => deployment.deployment_trigger?.metadata?.commit_message === marker(operationId, release) && deployment.deployment_trigger.metadata.commit_hash === release.manifest.sourceCommit && deployment.deployment_trigger.metadata.branch === pins.productionBranch);
    if (matches.length !== 1 || matches[0].environment !== 'production' || matches[0].latest_stage?.name !== 'deploy' || matches[0].latest_stage?.status !== 'success') return unknown();
    const project = await inspectPages();
    if (project.canonical_deployment?.id !== matches[0].id) return unknown();
    check(await sha256(encoder.encode(canonical(project.deployment_configs.production))) === row.value.configurationDigest, 'pages-configuration-drift');
    return applied({ manifestSha256: release.manifestSha256, deploymentId: matches[0].id });
  }
  const transport = {
    async verifyRelease(manifestBytes, signatureBytes) { const release = await verifier.verify(manifestBytes, signatureBytes); own.add(release); return release; },
    async stage(requestValue) {
      guard(requestValue, ['installationId', 'release', 'operationId', 'name', 'bytes']);
      const { release, name, operationId } = requestValue;
      const operationRow = await store.operation(operationId);
      if (operationRow) check(operationRow.value.kind === 'stage' && operationRow.value.digest === release.manifestSha256 && operationRow.value.name === name, 'operation-conflict');
      else await store.claim(operationId, { kind: 'stage', digest: release.manifestSha256, name, phase: 'prepare' });
      const admitted = await store.operation(operationId);
      check(admitted.value.kind === 'stage' && admitted.value.digest === release.manifestSha256 && admitted.value.name === name, 'operation-conflict');
      const bytes = await verifier.verifyArtifact(release, name, requestValue.bytes);
      if (descriptor(release, 'dashboard').name === name) readDashboard(bytes);
      const fileId = artifactId(release, name), file = await store.begin({ artifactId: fileId, bytes: bytes.length, digest: await sha256(bytes) });
      if (!file.sealed) {
        const next = await store.nextChunk(fileId);
        if (next < file.chunk_count) { await store.writeChunk(fileId, next, bytes.slice(next * ARTIFACT_CHUNK_BYTES, (next + 1) * ARTIFACT_CHUNK_BYTES)); return pending(); }
        await store.seal(fileId);
      }
      const receipt = { manifestSha256: release.manifestSha256, name, sha256: file.sha256 };
      const current = await store.operation(operationId);
      await set(operationId, current, { phase: 'complete', receipt });
      return applied(receipt);
    },
    async readStaged(requestValue) {
      guard(requestValue, ['installationId', 'release', 'name']);
      return verifier.verifyArtifact(requestValue.release, requestValue.name, await store.read(artifactId(requestValue.release, requestValue.name)));
    },
    async deployApi(requestValue) {
      guard(requestValue, ['installationId', 'release', 'operationId', 'priorRelease']);
      check(own.has(requestValue.priorRelease), 'untrusted-context');
      const { release, operationId } = requestValue, row = await operation(requestValue, 'api');
      const reconcileRequest = { installationId: requestValue.installationId, release, operationId };
      if (row.value.phase !== 'prepare') return transport.reconcile(reconcileRequest);
      const artifact = descriptor(release, 'api'), bytes = await transport.readStaged({ installationId: pins.installationId, release, name: artifact.name });
      const settings = await inspectWorker(requestValue.priorRelease);
      const form = new FormData();
      form.set('metadata', JSON.stringify({ ...pins.workerSettings, main_module: artifact.name, bindings: bindingsFor(release), keep_bindings: ['secret_text', 'secret_key'], keep_assets: true, annotations: { 'workers/message': marker(operationId, release) } }));
      form.set(artifact.name, new Blob([bytes], { type: 'application/javascript+module' }), artifact.name);
      const secrets = canonical(settings.bindings.filter(binding => ['secret_text', 'secret_key'].includes(binding.type)).map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name)));
      if (!await set(operationId, row, { phase: 'dispatched', secrets })) return unknown();
      try { await request(workerPath, { method: 'PUT', body: form }); return await transport.reconcile(reconcileRequest); }
      catch { return unknown(); }
    },
    async deployPages(requestValue) {
      guard(requestValue, ['installationId', 'release', 'operationId']);
      const { release, operationId } = requestValue, row = await operation(requestValue, 'pages');
      if (row.value.phase !== 'prepare') return transport.reconcile(requestValue);
      const project = await inspectPages();
      const configurationDigest = await sha256(encoder.encode(canonical(project.deployment_configs.production)));
      if (!row.value.configurationDigest) { await set(operationId, row, { configurationDigest }); return pending(); }
      check(row.value.configurationDigest === configurationDigest, 'pages-configuration-drift');
      const files = await pagesFiles(release), assets = files.filter(file => !special(file.path));
      if (row.value.index < assets.length) {
        const file = assets[row.value.index], { jwt } = await request(`${pagesPath}/upload-token`);
        check(typeof jwt === 'string', 'upload-token');
        const hash = pagesAssetHash(file.bytes, file.path);
        if (!await set(operationId, row, { phase: 'asset-dispatched' })) return unknown();
        try {
          await request('/pages/assets/upload', { method: 'POST', jwt, body: JSON.stringify([{ key: hash, value: toBase64(file.bytes), metadata: { contentType: contentType(file.path) }, base64: true }]) });
          const current = await store.operation(operationId);
          if (current.value.phase === 'asset-dispatched' && current.value.index === row.value.index) await set(operationId, current, { phase: 'prepare', index: row.value.index + 1 });
          return pending();
        } catch { return unknown(); }
      }
      const form = new FormData();
      form.set('manifest', JSON.stringify(Object.fromEntries(assets.map(file => [`/${file.path}`, pagesAssetHash(file.bytes, file.path)]))));
      form.set('branch', pins.productionBranch); form.set('commit_hash', release.manifest.sourceCommit); form.set('commit_message', marker(operationId, release)); form.set('commit_dirty', 'false');
      for (const file of files.filter(file => special(file.path))) form.set(file.path, new Blob([file.bytes]), file.path);
      if (!await set(operationId, row, { phase: 'dispatched' })) return unknown();
      try { await request(`${pagesPath}/deployments`, { method: 'POST', body: form }); return await transport.reconcile(requestValue); }
      catch { return unknown(); }
    },
    async reconcile(requestValue) {
      guard(requestValue, ['installationId', 'release', 'operationId']);
      const row = await store.operation(requestValue.operationId);
      if (!row || row.value.digest !== requestValue.release.manifestSha256) return unknown();
      if (row.value.receipt) return applied(row.value.receipt);
      if (row.value.phase === 'prepare') return pending();
      try {
        const result = row.value.kind === 'api' ? await reconcileApi(requestValue) : row.value.kind === 'pages' ? await reconcilePages(requestValue, row) : unknown();
        if (result.outcome === 'applied') await set(requestValue.operationId, row, { phase: 'complete', receipt: result.receipt });
        return result;
      } catch { return unknown(); }
    },
    async capturePrior(requestValue) {
      guard(requestValue, ['installationId', 'release', 'operationId']);
      const { release, operationId } = requestValue;
      const existing = await store.operation(operationId);
      if (existing) check(existing.value.kind === 'capture' && existing.value.digest === release.manifestSha256, 'operation-conflict');
      if (existing?.value.receipt) return applied(existing.value.receipt);
      if (!existing) await store.claim(operationId, { kind: 'capture', digest: release.manifestSha256, phase: 'prepare' });
      const admitted = await store.operation(operationId);
      check(admitted.value.kind === 'capture' && admitted.value.digest === release.manifestSha256, 'operation-conflict');
      const settings = await inspectWorker(release), project = await inspectPages();
      const deployments = await request(`${workerPath}/deployments`), active = deployments.deployments?.[0];
      check(active?.versions?.length === 1 && active.versions[0].percentage === 100, 'active-version');
      const version = await request(`${workerPath}/versions/${active.versions[0].version_id}`);
      check(version.id === active.versions[0].version_id, 'active-version');
      const response = await request(`${workerPath}/content/v2`, { binary: true });
      let bytes;
      if (response.headers.get('content-type')?.startsWith('multipart/')) {
        const form = await response.formData(), files = [...form.values()];
        check(files.length === 1 && files[0] instanceof Blob, 'worker-modules');
        bytes = new Uint8Array(await files[0].arrayBuffer());
      } else bytes = new Uint8Array(await response.arrayBuffer());
      const api = descriptor(release, 'api');
      await verifier.verifyArtifact(release, api.name, bytes);
      // Capture current code into the independent store a chunk at a time. The
      // prior signed Pages archive must already be staged by bootstrap/last update.
      const childHash = await sha256(encoder.encode(`capture-code:${operationId}`));
      const childId = `${childHash.slice(0, 8)}-${childHash.slice(8, 12)}-${childHash.slice(12, 16)}-${childHash.slice(16, 20)}-${childHash.slice(20, 32)}`;
      const stored = await transport.stage({ installationId: pins.installationId, release, operationId: childId, name: api.name, bytes });
      if (stored.outcome !== 'applied') return pending();
      await pagesFiles(release);
      const pagesMarker = project.canonical_deployment?.deployment_trigger?.metadata;
      check(pagesMarker?.commit_hash === release.manifest.sourceCommit && typeof pagesMarker.commit_message === 'string' && pagesMarker.commit_message.endsWith(` ${release.manifestSha256}`), 'prior-pages-release');
      const after = await request(`${workerPath}/deployments`);
      check(after.deployments?.[0]?.id === active.id && project.canonical_deployment?.id, 'capture-drift');
      const pagesAfter = await inspectPages();
      check(pagesAfter.canonical_deployment?.id === project.canonical_deployment.id && canonical(pagesAfter.deployment_configs.production) === canonical(project.deployment_configs.production), 'capture-drift');
      const receipt = { priorCode: { apiVersionId: version.id, apiDeploymentId: active.id, pagesDeploymentId: project.canonical_deployment.id, manifestSha256: release.manifestSha256 }, configuration: { worker: settings, pages: project.deployment_configs.production } };
      const current = await store.operation(operationId);
      await set(operationId, current, { phase: 'complete', receipt });
      return applied(receipt);
    },
  };
  return Object.freeze(transport);
}

// Concrete engine glue. Release resolvers are updater-owned: they reverify raw
// signed records from the engine/checkpoint, not manifests supplied by a browser.
// readManifest/readArtifact, backup/migration and health are supplied separately.
export function createCloudflareCodeAdapters({ transport, installationId, resolveRelease, resolveInstalledRelease, resolveDeployedRelease }) {
  check(typeof resolveDeployedRelease === 'function', 'deployed-release-resolver');
  const request = async (context, prior = false) => ({ installationId, operationId: context.operationId, release: await (prior ? resolveInstalledRelease : resolveRelease)(context) });
  const adapters = {
    async stageArtifact(context) { return transport.stage({ ...await request(context), name: context.artifact.name, bytes: context.bytes }); },
    async readStagedArtifact(context) { return transport.readStaged({ installationId, release: await resolveRelease(context), name: context.artifact.name }); },
    async captureCheckpoint(context) { return transport.capturePrior(await request(context, true)); },
    async readRecoveryArtifact(context) { return transport.readStaged({ installationId, release: await resolveRelease(context), name: context.artifact.name }); },
    async deployApi(context) { return transport.deployApi({ ...await request(context), priorRelease: await resolveDeployedRelease(context) }); },
    async deployPages(context) { return transport.deployPages(await request(context)); },
    async reconcile(context) { return transport.reconcile(await request(context, context.kind === 'captureCheckpoint')); },
    async continueOperation(context) {
      check(['stageArtifact', 'captureCheckpoint', 'deployApi', 'deployPages'].includes(context.kind), 'continuation-kind');
      return adapters[context.kind](context);
    },
  };
  return Object.freeze(adapters);
}
