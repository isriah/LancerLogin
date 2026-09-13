import { createApplicationVerifier } from '../../packages/shared/src/updater/application-release.mjs';
import { readDashboard } from '../../packages/shared/src/updater/dashboard-archive.mjs';
import { createGitHubReleaseSource } from './github-release-source.mjs';
import { createUpdaterService } from './service.mjs';
import { createControlService } from './control-service.mjs';
import { createRecoveryService } from './recovery-service.mjs';
import { createMaintenanceService } from './maintenance-service.mjs';
import { createUpdaterStore } from './src/store.mjs';
import { createArtifactStore } from './src/artifact-store.mjs';
import { createCheckpointCipher, toBase64, fromBase64 } from './src/checkpoint.mjs';
import { createCloudflareCodeTransport, createCloudflareCodeAdapters } from './src/cloudflare-code.mjs';
import { createVerifiedBackup } from './src/backup.mjs';
import { createPostDeploymentHealth } from './src/health.mjs';
import { createMaintenanceOrchestration } from './src/orchestration.mjs';
import { selectSnapshotCatalog } from './src/snapshot-catalog-registry.mjs';
import { createBootstrapPreflight } from './src/bootstrap-preflight.mjs';
import { createRuntimeRestore } from './src/runtime-restore.mjs';
import { createMigrationTransport } from './src/migrations.mjs';
const check = (ok) => { if (!ok) throw Error('runtime-identity'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (value, keys) => check(value && Object.keys(value).sort().join(',') === [...keys].sort().join(','));

export async function createUpdaterRuntime({ pins: input, trust, bindings, secrets, bootstrapCapability, fencePolicy, fetch: fetcher = globalThis.fetch }) {
  const pins = structuredClone(input);
  exact(pins, ['installationId','accountId','worker','pagesProject','productionBranch','applicationDatabaseId','updaterDatabaseId','validationDatabaseId','workerSettings','nonsecretBindings','apiOrigin','dashboardOrigin','recoveryOrigin']);
  exact(bindings, ['application','updater','validation']); exact(secrets, ['checkpointKey','githubToken','cloudflareToken','appHmac','maintenanceHmac','recoveryCredentialSha256']);
  check(new Set(Object.values(bindings)).size === 3 && Object.values(bindings).every(db => typeof db?.prepare === 'function') && bootstrapCapability && typeof bootstrapCapability === 'object' && secrets.appHmac !== secrets.maintenanceHmac);
  const capability = {}, executionCapability = {};
  const primary = db => ({ prepare(sql) { return (db.withSession ? db.withSession('first-primary') : db).prepare(sql); }, batch(statements) { return (db.withSession ? db.withSession('first-primary') : db).batch(statements); } });
  const database = primary(bindings.updater), store = createUpdaterStore(database, pins.installationId);
  const cipher = await createCheckpointCipher(Uint8Array.from(secrets.checkpointKey), pins.installationId), artifacts = createArtifactStore({ database, installationId: pins.installationId, cipher });
  const verifier = createApplicationVerifier(trust), source = createGitHubReleaseSource({ pins: trust, token: secrets.githubToken, fetch: fetcher });
  const select = names => Object.fromEntries(names.map(name => [name, pins[name]]));
  const code = createCloudflareCodeTransport({ pins: select(['installationId','accountId','worker','pagesProject','productionBranch','applicationDatabaseId','workerSettings','nonsecretBindings']), token: secrets.cloudflareToken, verifier, store: artifacts, fetch: fetcher });
  const preflight=createBootstrapPreflight({pins,database:bindings.application,store:artifacts,verifier,token:secrets.cloudflareToken,fetch:fetcher});
  const record = (releaseId, manifestBytes, signatureBytes) => ({ releaseId, manifest: toBase64(manifestBytes), signature: toBase64(signatureBytes) });
  async function retained(raw) {
    const release = await verifier.verify(fromBase64(raw.manifest), fromBase64(raw.signature));
    const key = `runtime-release:${release.manifestSha256}`, previous = await artifacts.operation(key);
    if (!previous) await artifacts.claim(key, raw);
    check(same((await artifacts.operation(key)).value, raw)); return release;
  }
  async function rawRelease(digest) { const raw = (await artifacts.operation(`runtime-release:${digest}`))?.value; check(raw); check((await verifier.verify(fromBase64(raw.manifest), fromBase64(raw.signature))).manifestSha256 === digest); return raw; }
  async function resolve(context, transport = code, installed = false) {
    const current = (await store.read()).state, raw = installed ? current.release : current.job?.release;
    check(raw && current.job?.id === context.jobId);
    const release = await retained(raw); if (!installed) check(release.manifestSha256 === context.manifestSha256);
    return transport.verifyRelease(fromBase64(raw.manifest), fromBase64(raw.signature));
  }
  async function deployed(context) {
    const pointer = (await artifacts.operation('runtime-api'))?.value;
    if (!pointer) return resolve(context, code, true);
    const operation = (await artifacts.operation(pointer.operationId))?.value;
    check(operation?.kind === 'api' && operation.digest === pointer.digest && operation.receipt?.manifestSha256 === pointer.digest);
    const raw = await rawRelease(pointer.digest); return code.verifyRelease(fromBase64(raw.manifest), fromBase64(raw.signature));
  }
  async function remember(kind, context, result) {
    if (result.outcome !== 'applied' || !['deployApi','deployPages'].includes(kind)) return result;
    const key = kind === 'deployApi' ? 'runtime-api' : 'runtime-pages', value = { operationId: context.operationId, digest: context.manifestSha256 };
    const operation = (await artifacts.operation(value.operationId))?.value;
    check(operation?.receipt?.manifestSha256 === value.digest && same(operation.receipt, result.receipt));
    const previous = await artifacts.operation(key);
    check(previous ? await artifacts.replace(key, previous.revision, value) : await artifacts.claim(key, value)); return result;
  }
  let health;
  async function trustedHealth() {
    const current = (await store.read()).state, job = current.job;
    let healthOperationId = job?.operation?.kind === 'health' ? job.operation.id : null;
    if (!healthOperationId) { const reopen = (await artifacts.operation(`runtime-reopen:${job?.id}`))?.value; check(reopen); healthOperationId = reopen.operationId; }
    const api = (await artifacts.operation('runtime-api'))?.value, pages = (await artifacts.operation('runtime-pages'))?.value;
    check(api && pages);
    return { healthOperationId, apiOperationId: api.operationId, pagesOperationId: pages.operationId, schema: current.installed.schema, ledger: current.installed.ledger, mode: job.mode };
  }
  health = createPostDeploymentHealth({ pins: select(['installationId','accountId','worker','pagesProject','productionBranch','applicationDatabaseId','apiOrigin','dashboardOrigin']), token: secrets.cloudflareToken, verifier, store: artifacts, readTrustedState: trustedHealth, fetch: fetcher });
  async function runHealth(context) { return health.advance({ installationId: pins.installationId, operationId: context.operationId, release: await resolve(context, health) }); }
  async function readHealthEvidence(expected) {
    const key = `runtime-reopen:${expected.jobId}`; let row = await artifacts.operation(key);
    if (!row) { await artifacts.claim(key, { expected, operationId: crypto.randomUUID() }); row = await artifacts.operation(key); }
    check(same(row.value.expected, expected));
    const current = (await store.read()).state; check(current.job.id === expected.jobId && !current.job.operation);
    const raw = current.release, release = await health.verifyRelease(fromBase64(raw.manifest), fromBase64(raw.signature)); check(release.manifestSha256 === expected.manifestSha256);
    const result = await health.advance({ installationId: pins.installationId, operationId: row.value.operationId, release });
    if (result.outcome === 'failed') {
      check(await artifacts.replace(key, row.revision, { expected, operationId: crypto.randomUUID() }));
      return { verified: false };
    }
    if (result.outcome !== 'applied') return { outcome: 'pending' };
    check(result.receipt.manifestSha256 === expected.manifestSha256 && result.receipt.version === expected.version && result.receipt.schema === expected.schema);
    return { ...expected, verified: true };
  }
  const engine = createMaintenanceOrchestration({ database, installationId: pins.installationId, store, verifier, cipher, readDashboard, capability, executionCapability, readHealthEvidence,
    createAdapters({ withClosedEpoch }) {
      const backup = createVerifiedBackup({ pins: select(['installationId','applicationDatabaseId','updaterDatabaseId','validationDatabaseId']), applicationDatabase: bindings.application, validationDatabase: bindings.validation, store: artifacts, withClosedEpoch });
      const restore = fencePolicy ? createRuntimeRestore({pins,policy:structuredClone(fencePolicy),database:bindings.application,updaterDatabase:database,artifacts,store,cipher,verifier,withClosedEpoch,token:secrets.cloudflareToken,fetch:fetcher}) : {};
      const migrations = createMigrationTransport({ pins: select(['installationId','applicationDatabaseId','updaterDatabaseId']), database: bindings.application, store: artifacts, verifier, withClosedEpoch });
      async function migrate(context, reconcileOnly = false) {
        const release = await resolve(context, migrations), name = context.migration?.artifact ?? context.name;
        const migration = release.manifest.migrations.find(item => item.artifact === name); check(migration);
        const codeRelease = await resolve(context), bytes = await code.readStaged({ installationId: pins.installationId, release: codeRelease, name });
        return migrations[reconcileOnly ? 'reconcileMigration' : 'applyMigration']({ operationId: context.operationId, release, migrationId: migration.id, bytes });
      }
      const codeAdapters = createCloudflareCodeAdapters({ transport: code, installationId: pins.installationId, resolveRelease: context => resolve(context), resolveInstalledRelease: context => resolve(context, code, true), resolveDeployedRelease: deployed });
      const adapters = { ...codeAdapters, ...restore, backup: backup.backup, health: runHealth, applyMigration: context => migrate(context),
        async readManifest({ releaseId }) {
          const handle = await source.resolve(releaseId), raw = record(releaseId, handle.manifestBytes, handle.signatureBytes), release = await retained(raw);
          const key = `runtime-source:${release.manifestSha256}`, previous = await artifacts.operation(key);
          if (!previous) await artifacts.claim(key, handle.identity); check(same((await artifacts.operation(key)).value, handle.identity));
          return { manifestBytes: handle.manifestBytes, signatureBytes: handle.signatureBytes };
        },
        async readArtifact(context) { const identity = (await artifacts.operation(`runtime-source:${context.manifestSha256}`))?.value; check(identity); return source.download(await source.resume(identity), context.artifact.name); },
        async continueOperation(context) { if(context.kind==='restoreBackup')return restore.continueRestore(context,false); if (context.kind === 'backup') return backup.continueOperation(context); if (context.kind === 'health') return runHealth(context); if (context.kind === 'applyMigration') return migrate(context, true); return remember(context.kind, context, await codeAdapters.continueOperation(context)); },
        async reconcile(context) { if(context.kind==='restoreBackup')return restore.continueRestore(context,true); if (context.kind === 'backup') return backup.reconcile(context); if (context.kind === 'health') return runHealth(context); if (context.kind === 'applyMigration') return migrate(context, true); return remember(context.kind, context, await codeAdapters.reconcile(context)); },
      };
      for (const kind of ['deployApi','deployPages']) adapters[kind] = async context => remember(kind, context, await codeAdapters[kind](context));
      return adapters;
    },
  });
  const controls = createControlService({engine,store,database,capability,installationId:pins.installationId,origin:pins.recoveryOrigin,dashboardOrigin:pins.dashboardOrigin});
  const application = createUpdaterService({ engine, source, store, database, capability, installationId: pins.installationId, appSecret: secrets.appHmac, controls, recoveryOrigin: pins.recoveryOrigin });
  const maintenance = createMaintenanceService({ core: engine.executionCore, capability: executionCapability, installationId: pins.installationId, appSecret: secrets.maintenanceHmac });
  const recovery = createRecoveryService({ engine, store, database, capability, installationId: pins.installationId, origin: pins.recoveryOrigin, credentialSha256: secrets.recoveryCredentialSha256 });
  return Object.freeze({
    controls: Object.freeze({ fetch: controls.fetch }), application: Object.freeze({ fetch: application.fetch }), maintenance: Object.freeze({ fetch: maintenance.fetch }), recovery: Object.freeze({ fetch: recovery.fetch }),
    async initialize(actual, input) {
      check(actual === bootstrapCapability); exact(input, ['releaseId','manifestBytes','signatureBytes','updaterVersion','artifacts','adoption']);
      const raw = record(input.releaseId, input.manifestBytes, input.signatureBytes), release = await retained(raw);
      check([46,49].includes(release.manifest.targetSchema));
      const catalog = selectSnapshotCatalog(`schema-${release.manifest.targetSchema}-v1`).catalog;
      check(same(release.manifest.migrations.map(({ id, sha256 }) => ({ id, sha256 })), catalog.ledger));
      const identity = { raw, updaterVersion: input.updaterVersion, preflightIdentity:await preflight.identity(release,input.adoption) }, key = 'runtime-bootstrap'; let row = await artifacts.operation(key);
      if (!row) { check(!await store.read()); await artifacts.claim(key, { identity, index: 0, operations: release.manifest.artifacts.map(() => crypto.randomUUID()) }); row = await artifacts.operation(key); }
      check(same(row.value.identity, identity));
      if (row.value.complete) return { outcome: 'initialized' };
      const installed = await store.read();
      if (installed) { check(row.value.index === release.manifest.artifacts.length && installed.state.format === 1 && installed.state.job === null && installed.state.checkpoint === null && same(installed.state.release, raw) && same(installed.state.installed, { version: release.manifest.version, schema: catalog.schema, updaterVersion: input.updaterVersion, highestSequence: release.manifest.sequence, ledger: catalog.ledger })); }
      else if (row.value.index < release.manifest.artifacts.length) {
        const descriptor = release.manifest.artifacts[row.value.index], bytes = input.artifacts.get(descriptor.name); check(bytes instanceof Uint8Array);
        const handle = await code.verifyRelease(input.manifestBytes, input.signatureBytes), result = await code.stage({ installationId: pins.installationId, release: handle, operationId: row.value.operations[row.value.index], name: descriptor.name, bytes });
        if (result.outcome === 'applied') check(await artifacts.replace(key, row.revision, { ...row.value, index: row.value.index + 1 }));
        return { outcome: 'pending' };
      } else {if((await preflight.advance(release,input.adoption)).outcome!=='ready')return {outcome:'pending'};await preflight.guard(release,input.adoption);await engine.initialize(capability, { releaseId: input.releaseId, manifestBytes: input.manifestBytes, signatureBytes: input.signatureBytes, updaterVersion: input.updaterVersion, ledger: catalog.ledger });}
      await preflight.guard(release,input.adoption);
      check(await artifacts.replace(key, row.revision, { ...row.value, complete: true })); return { outcome: 'initialized' };
    },
  });
}
