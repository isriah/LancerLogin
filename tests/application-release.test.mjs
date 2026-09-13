import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { packageApplicationRelease } from '../scripts/package-application-release.mjs';
import { createApplicationVerifier } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
// Existing security cases now exercise the shared production module on every full run.
import '../experiments/release-trust/verifier.test.mjs';
const bytes = text => new TextEncoder().encode(text);
const metadata = {
  format: 1, kind: 'application', product: 'LancerLogin', channel: 'development', keyId: 'synthetic-test',
  repository: { id: 123, owner: 'synthetic', name: 'release-test' }, sequence: 2, version: '1.1.0',
  sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '1.0.0',
  compatibility: { installedVersion: { min: '1.0.0', max: '1.0.0' }, installedSchema: { min: 0, max: 0 }, apiVersion: 1, apiSchema: { min: 0, max: 1 }, frontendApi: { min: 1, max: 1 } },
  targetSchema: 1, codeRollback: 'compatible',
};

test('maintainer CLI signs actual API, dashboard and migration bytes; portable verifier stages them and rejects tampering', async t => {
  const root = await mkdtemp(join(tmpdir(), 'll-synthetic-release-')); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { metadata: join(root, 'metadata.json'), api: join(root, 'api.mjs'), dashboard: join(root, 'dashboard'), migrations: join(root, 'migrations'), signingKey: join(root, 'ephemeral.pem'), out: join(root, 'release') };
  await mkdir(options.dashboard); await mkdir(join(options.dashboard, 'assets')); await mkdir(options.migrations);
  await writeFile(options.metadata, JSON.stringify(metadata));
  await writeFile(options.api, 'export default {fetch(){return new Response("synthetic");}};\n');
  await writeFile(join(options.dashboard, 'index.html'), '<!doctype html><script src="/assets/app.js"></script>');
  await writeFile(join(options.dashboard, 'assets/app.js'), 'document.title="Synthetic release";');
  await writeFile(join(options.dashboard, '_worker.js'), 'export default {fetch(request,env){return env.ASSETS.fetch(request);}};');
  await writeFile(join(options.migrations, '0001_initial.sql'), 'CREATE TABLE synthetic(id INTEGER PRIMARY KEY);\n');
  const pair = generateKeyPairSync('ed25519');
  await writeFile(options.signingKey, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const flags = Object.entries(options).flatMap(([name, value]) => ['--' + (name === 'signingKey' ? 'signing-key' : name), value]);
  const cli = spawnSync(process.execPath, ['scripts/package-application-release.mjs', ...flags], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).artifacts, 3);
  assert.deepEqual((await readdir(options.out)).sort(), ['0001_initial.sql', 'api.mjs', 'dashboard.tar', 'manifest.json', 'manifest.sig']);
  const publicKey = new Uint8Array(Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'));
  const verifier = createApplicationVerifier({ product: metadata.product, channel: metadata.channel, repository: metadata.repository, keyId: metadata.keyId, publicKey });
  const manifest = await readFile(join(options.out, 'manifest.json')), signature = await readFile(join(options.out, 'manifest.sig'));
  const verified = await verifier.verify(manifest, signature);
  for (const artifact of verified.manifest.artifacts) await verifier.verifyArtifact(verified, artifact.name, await readFile(join(options.out, artifact.name)));
  const archive = await verifier.verifyArtifact(verified, 'dashboard.tar', await readFile(join(options.out, 'dashboard.tar')));
  assert.deepEqual(readDashboard(archive).map(file => file.path), ['_worker.js', 'assets/app.js', 'index.html']);
  const evaluation = verifier.evaluateUpdate(verified, { version: '1.0.0', schema: 0, updaterVersion: '1.0.0', highestSequence: 1, ledger: [] });
  assert.equal(evaluation.migrations[0].id, '0001_initial.sql');
  await assert.rejects(verifier.verify(Buffer.concat([manifest, Buffer.from('\n')]), signature), /signature/);
  archive[512] ^= 1; await assert.rejects(verifier.verifyArtifact(verified, 'dashboard.tar', archive), /artifact-digest/);
  await packageApplicationRelease({ ...options, out: join(root, 'second') });
  assert.deepEqual(await readFile(join(root, 'second/manifest.json')), manifest);
  assert.deepEqual(await readFile(join(root, 'second/manifest.sig')), signature);
  await assert.rejects(packageApplicationRelease(options), /EEXIST/);
  await writeFile(join(options.dashboard, '.env'), 'SYNTHETIC_ONLY=yes');
  await assert.rejects(packageApplicationRelease({ ...options, out: join(root, 'hidden') }), /dashboard-path/);
  await rm(join(options.dashboard, '.env'));
  await link(options.api, join(options.dashboard, 'linked.js'));
  await assert.rejects(packageApplicationRelease({ ...options, out: join(root, 'hardlink') }), /input-regular-file/);
});

test('dashboard archive rejects traversal, links, duplicate paths, noncanonical padding and oversized inputs', () => {
  const entry = { path: 'index.html', bytes: bytes('synthetic') };
  const original = packDashboard([entry]); assert.deepEqual(readDashboard(original)[0].bytes, entry.bytes);
  for (const path of ['../index.html', '/index.html', 'C:/index.html', 'a\\index.html', '.env', 'assets/../index.html', 'assets/.secret.js', 'credentials.json', 'index.html\n']) {
    assert.throws(() => packDashboard([entry, { path, bytes: bytes('x') }]), /dashboard-/);
  }
  assert.throws(() => packDashboard([entry, { ...entry, path: 'INDEX.html' }]), /dashboard-duplicate/);
  for (const type of ['1', '2', '5', 'x', 'g']) {
    const archive = original.slice(); archive[156] = type.charCodeAt(0);
    assert.throws(() => readDashboard(archive), /dashboard-header/);
  }
  const padding = original.slice(); padding[512 + entry.bytes.length] = 1;
  assert.throws(() => readDashboard(padding), /dashboard-padding/);
  assert.throws(() => readDashboard(original.slice(0, -512)), /dashboard-truncated/);
  const trailing = new Uint8Array(original.length + 512); trailing.set(original);
  assert.throws(() => readDashboard(trailing), /dashboard-/);
  assert.throws(() => packDashboard([entry, { path: 'large.js', bytes: new Uint8Array(8388609) }]), /dashboard-file-size/);
});
