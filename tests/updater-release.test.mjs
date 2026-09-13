import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApplicationVerifier, signedBytes, sha256 } from '../packages/shared/src/updater/application-release.mjs';
import { createUpdaterReleaseVerifier, updaterSignedBytes } from '../packages/shared/src/updater/updater-release.mjs';
import { packageUpdaterRelease } from '../scripts/package-updater-release.mjs';

const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
async function fixture() {
  const pair = generateKeyPairSync('ed25519'), publicKey = new Uint8Array(Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'));
  const pins = { product: 'LancerLogin', channel: 'development', keyId: 'synthetic', repository: { id: 1, owner: 'synthetic', name: 'updater' }, publicKey };
  const artifact = encode('export default {fetch(){return new Response("synthetic updater")}};');
  const metadata = { format: 1, kind: 'updater', product: pins.product, channel: pins.channel, keyId: pins.keyId, repository: pins.repository, sequence: 2, version: '2.0.0', sourceCommit: 'a'.repeat(40), compatibility: { updaterVersion: { min: '1.0.0', max: '1.9.0' }, stateSchema: { min: 2, max: 4 } }, targetStateSchema: 3 };
  const manifest = { ...metadata, artifact: { role: 'updater', name: 'updater.mjs', bytes: artifact.length, sha256: await sha256(artifact) } };
  const signature = (data, domain = updaterSignedBytes) => new Uint8Array(sign(null, domain(data), pair.privateKey));
  const verifier = createUpdaterReleaseVerifier(pins), bytes = encode(manifest), installed = { updaterVersion: '1.0.0', stateSchema: 3, highestUpdaterSequence: 1 };
  return { pair, pins, artifact, metadata, manifest, signature, verifier, bytes, installed };
}

test('updater signatures and opaque handles are separate from application releases with the same key', async () => {
  const f = await fixture(), app = createApplicationVerifier(f.pins);
  const updater = await f.verifier.verify(f.bytes, f.signature(f.bytes));
  assert.deepEqual(await f.verifier.verifyArtifact(updater, f.artifact), f.artifact);
  await assert.rejects(f.verifier.verify(f.bytes, f.signature(f.bytes, signedBytes)), /updater-signature/);
  await assert.rejects(app.verify(f.bytes, f.signature(f.bytes)), /schema/);
  await assert.rejects(app.verifyArtifact(updater, 'updater.mjs', f.artifact), /unverified-manifest/);
  await assert.rejects(f.verifier.verifyArtifact(structuredClone(updater), f.artifact), /unverified-updater-manifest/);
  await assert.rejects(createUpdaterReleaseVerifier(f.pins).verifyArtifact(updater, f.artifact), /unverified-updater-manifest/);
  const appManifest = { format: 1, kind: 'application', product: f.pins.product, channel: f.pins.channel, keyId: f.pins.keyId, repository: f.pins.repository, sequence: 100, version: '5.0.0', sourceCommit: 'b'.repeat(40), minimumUpdaterVersion: '1.0.0', compatibility: { installedVersion: { min: '1.0.0', max: '5.0.0' }, installedSchema: { min: 0, max: 0 }, apiVersion: 1, apiSchema: { min: 0, max: 0 }, frontendApi: { min: 1, max: 1 } }, targetSchema: 0, codeRollback: 'compatible', artifacts: [{ role: 'api', name: 'api.mjs', bytes: 1, sha256: await sha256(encode('x')) }, { role: 'dashboard', name: 'dashboard.tar', bytes: 1, sha256: await sha256(encode('x')) }], migrations: [] };
  const appBytes = encode(appManifest), appHandle = await app.verify(appBytes, f.signature(appBytes, signedBytes));
  await assert.rejects(f.verifier.verify(appBytes, f.signature(appBytes, signedBytes)), /updater-schema/);
  await assert.rejects(f.verifier.verifyArtifact(appHandle, f.artifact), /unverified-updater-manifest/);
  await assert.rejects(app.verify(appBytes, f.signature(appBytes)), /signature/);
});

test('strict updater manifest rejects overrides, wrong pins, duplicate keys and changed bytes', async () => {
  const f = await fixture();
  for (const field of ['bindings', 'accountId', 'worker', 'secrets', 'trust', 'commands', 'migrations']) {
    const data = encode({ ...f.manifest, [field]: {} });
    await assert.rejects(f.verifier.verify(data, f.signature(data)), /updater-schema/);
  }
  const duplicate = encode(JSON.stringify(f.manifest).replace('"version":', '"version":"1.0.0","version":'));
  await assert.rejects(f.verifier.verify(duplicate, f.signature(duplicate)), /duplicate-key/);
  const wrongSource = encode({ ...f.manifest, repository: { ...f.manifest.repository, id: 2 } });
  await assert.rejects(f.verifier.verify(wrongSource, f.signature(wrongSource)), /updater-source/);
  const wrongChannel = encode({ ...f.manifest, channel: 'production' });
  await assert.rejects(f.verifier.verify(wrongChannel, f.signature(wrongChannel)), /updater-trust/);
  const changed = encode(JSON.stringify(f.manifest) + '\n');
  await assert.rejects(f.verifier.verify(changed, f.signature(f.bytes)), /updater-signature/);
  const verified = await f.verifier.verify(f.bytes, f.signature(f.bytes)), bad = f.artifact.slice(); bad[0] ^= 1;
  await assert.rejects(f.verifier.verifyArtifact(verified, bad), /updater-artifact-integrity/);
});

test('updater sequence is independent and incompatible state requires a real migration protocol', async () => {
  const f = await fixture(), verified = await f.verifier.verify(f.bytes, f.signature(f.bytes));
  assert.equal(f.verifier.evaluateUpdate(verified, f.installed).nextHighestUpdaterSequence, 2);
  assert.throws(() => f.verifier.evaluateUpdate(verified, { ...f.installed, highestUpdaterSequence: 2 }), /updater-downgrade/);
  assert.throws(() => f.verifier.evaluateUpdate(verified, { ...f.installed, updaterVersion: '2.0.0' }), /updater-downgrade/);
  assert.throws(() => f.verifier.evaluateUpdate(verified, { ...f.installed, updaterVersion: '0.9.0' }), /updater-installed-compatibility/);
  assert.throws(() => f.verifier.evaluateUpdate(verified, { ...f.installed, stateSchema: 4 }), /updater-state-migration-required/);
  assert.throws(() => f.verifier.evaluateUpdate(verified, { ...f.installed, stateSchema: 5 }), /updater-installed-compatibility/);
  assert.throws(() => f.verifier.evaluateUpdate(verified, { version: '1.0.0', schema: 3, highestSequence: 1 }), /updater-schema/);
});

test('maintainer CLI signs a deterministic prebuilt bundle, self-verifies and refuses overwrite or key overlap', async t => {
  const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'lancer-updater-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'inputs')); await mkdir(join(root, 'keys'));
  const options = { metadata: join(root, 'inputs/metadata.json'), updater: join(root, 'inputs/worker.mjs'), signingKey: join(root, 'keys/signing.pem'), out: join(root, 'release') };
  await writeFile(options.metadata, JSON.stringify(f.metadata)); await writeFile(options.updater, f.artifact);
  await writeFile(options.signingKey, f.pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const args = ['--metadata', options.metadata, '--updater', options.updater, '--signing-key', options.signingKey, '--out', options.out];
  const cli = spawnSync(process.execPath, ['scripts/package-updater-release.mjs', ...args], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).updaterSequence, 2);
  assert.deepEqual((await readdir(options.out)).sort(), ['manifest.json', 'manifest.sig', 'updater.mjs']);
  const manifest = await readFile(join(options.out, 'manifest.json')), signature = await readFile(join(options.out, 'manifest.sig'));
  const verified = await f.verifier.verify(manifest, signature);
  assert.deepEqual(await f.verifier.verifyArtifact(verified, await readFile(join(options.out, 'updater.mjs'))), f.artifact);
  await packageUpdaterRelease({ ...options, out: join(root, 'second') });
  assert.deepEqual(await readFile(join(root, 'second/manifest.json')), manifest);
  assert.deepEqual(await readFile(join(root, 'second/manifest.sig')), signature);
  await assert.rejects(packageUpdaterRelease(options), /EEXIST/);
  const invalidCli = spawnSync(process.execPath, ['scripts/package-updater-release.mjs', ...args], { encoding: 'utf8' });
  assert.equal(invalidCli.status, 1); assert.doesNotMatch(invalidCli.stderr, /PRIVATE KEY|signing\.pem/);
  await assert.rejects(packageUpdaterRelease({ ...options, updater: options.signingKey, out: join(root, 'overlap') }), /updater-signing-key-overlap/);
});
