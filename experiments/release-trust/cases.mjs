import { createApplicationVerifier, DOMAIN, LIMITS, parseStrictJson, sha256, signedBytes } from './verifier.mjs';

export const encode = text => new TextEncoder().encode(text);
const assert = (condition, detail = 'assertion') => { if (!condition) throw new Error(detail); };
const rejects = async (action, expected) => {
  try { await action(); } catch (error) { assert(error.message === expected, `expected ${expected}, received ${error.message}`); return; }
  throw new Error(`expected rejection: ${expected}`);
};
export const syntheticPins = publicKey => ({ product: 'LancerLogin', channel: 'synthetic-dev', repository: { id: 12345, owner: 'synthetic-owner', name: 'synthetic-release-source' }, keyId: 'ephemeral-test', publicKey });
export async function webSigner() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    sign: async bytes => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes)),
  };
}
export async function fixture(signer, change = () => {}) {
  const contents = {
    'api.mjs': encode('export default { fetch() { return new Response("synthetic"); } };'),
    'dashboard.tar': encode('synthetic archive bytes; not a deployable archive'),
    '0001_initial.sql': encode('CREATE TABLE synthetic (id INTEGER PRIMARY KEY);'),
    '0002_upgrade.sql': encode('ALTER TABLE synthetic ADD COLUMN label TEXT;'),
  };
  const artifacts = await Promise.all(Object.entries(contents).map(async ([name, bytes]) => ({ role: name.endsWith('.sql') ? 'migration' : name.endsWith('.mjs') ? 'api' : 'dashboard', name, bytes: bytes.length, sha256: await sha256(bytes) })));
  const manifest = {
    format: 1, kind: 'application', product: 'LancerLogin', channel: 'synthetic-dev', keyId: 'ephemeral-test', repository: syntheticPins(signer.publicKey).repository,
    sequence: 2, version: '0.2.0', sourceCommit: 'a'.repeat(40), minimumUpdaterVersion: '0.1.0',
    compatibility: { installedVersion: { min: '0.1.0', max: '0.1.9' }, installedSchema: { min: 1, max: 1 }, apiVersion: 2, apiSchema: { min: 2, max: 3 }, frontendApi: { min: 2, max: 2 } },
    targetSchema: 2, codeRollback: 'compatible', artifacts,
    migrations: artifacts.filter(a => a.role === 'migration').map((a, i) => ({ id: a.name, fromSchema: i, toSchema: i + 1, artifact: a.name, sha256: a.sha256 })),
  };
  change(manifest);
  const bytes = encode(JSON.stringify(manifest));
  return { manifest, bytes, signature: await signer.sign(signedBytes(bytes)), contents, state: { version: '0.1.0', schema: 1, updaterVersion: '0.1.0', highestSequence: 1, ledger: artifacts.filter(a => a.role === 'migration').slice(0, 1).map(a => ({ id: a.name, sha256: a.sha256 })) } };
}
async function context(change) {
  const signer = await webSigner(), f = await fixture(signer, change), verifier = createApplicationVerifier(syntheticPins(signer.publicKey));
  return { ...f, signer, verifier, verify: () => verifier.verify(f.bytes, f.signature) };
}

export const cases = [
  ['valid manifest, exact artifacts, and one pending migration', async () => {
    const f = await context(), v = await f.verify();
    assert(Object.isFrozen(v.manifest.compatibility.apiSchema));
    const plan = f.verifier.evaluateUpdate(v, f.state);
    assert(plan.mode === 'update' && plan.nextHighestSequence === 2 && plan.migrations.length === 1 && plan.migrations[0].id === '0002_upgrade.sql');
    for (const [name, bytes] of Object.entries(f.contents)) assert(await sha256(await f.verifier.verifyArtifact(v, name, bytes)) === await sha256(bytes));
  }],
  ['signature covers original UTF-8 bytes and domain', async () => {
    const f = await context();
    await rejects(() => f.verifier.verify(encode(JSON.stringify(f.manifest, null, 2)), f.signature), 'signature');
    const formatted = encode(JSON.stringify(f.manifest, null, 2));
    await f.verifier.verify(formatted, await f.signer.sign(signedBytes(formatted)));
    await rejects(() => f.verifier.verify(f.bytes, new Uint8Array(64)), 'signature');
    await rejects(async () => f.verifier.verify(f.bytes, await f.signer.sign(f.bytes)), 'signature');
    await rejects(async () => f.verifier.verify(f.bytes, await f.signer.sign(encode(DOMAIN.replace('\n', '\r\n') + new TextDecoder().decode(f.bytes)))), 'signature');
    const changed = structuredClone(f.manifest); changed.sourceCommit = 'b'.repeat(40);
    await rejects(() => f.verifier.verify(encode(JSON.stringify(changed)), f.signature), 'signature');
  }],
  ['reject wrong signing key, source identity, channel, and unknown key', async () => {
    const f = await context(), other = await webSigner();
    await rejects(() => createApplicationVerifier(syntheticPins(other.publicKey)).verify(f.bytes, f.signature), 'signature');
    for (const [key, value] of [['id', 54321], ['owner', 'wrong-owner'], ['name', 'wrong-repository']]) {
      const changed = await fixture(f.signer, m => { m.repository[key] = value; });
      await rejects(() => f.verifier.verify(changed.bytes, changed.signature), 'source');
    }
    for (const key of ['channel', 'keyId']) {
      const changed = await fixture(f.signer, m => { m[key] = 'wrong'; }); await rejects(() => f.verifier.verify(changed.bytes, changed.signature), 'trust');
    }
    const changed = await fixture(f.signer, m => { m.product = 'Other'; }); await rejects(() => f.verifier.verify(changed.bytes, changed.signature), 'schema');
  }],
  ['reject duplicate and escaped duplicate JSON keys at any depth', async () => {
    const f = await context();
    for (const text of [
      new TextDecoder().decode(f.bytes).replace('"format":1', '"format":1,"format":1'),
      new TextDecoder().decode(f.bytes).replace('"format":1', '"format":1,"for\\u006dat":1'),
      new TextDecoder().decode(f.bytes).replace('"id":12345', '"id":12345,"id":12345'),
      new TextDecoder().decode(f.bytes).replace('"role":"api"', '"role":"api","role":"api"'),
    ]) { const bytes = encode(text); await rejects(async () => f.verifier.verify(bytes, await f.signer.sign(signedBytes(bytes))), 'duplicate-key'); }
  }],
  ['reject invalid UTF-8, BOM, JSON, excessive nesting and sizes', async () => {
    const f = await context();
    for (const bytes of [new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xef, 0xbb, 0xbf, ...f.bytes])]) await rejects(() => f.verifier.verify(bytes, f.signature), 'utf8');
    for (const text of ['{}{}', '{"x":01}', '{"x":true,}', '{"x":"\n"}', '[1,]', '{"x":"\\uZZZZ"}']) await rejects(() => parseStrictJson(encode(text)), 'json');
    await rejects(() => parseStrictJson(encode('['.repeat(14) + '0' + ']'.repeat(14))), 'complexity');
    await rejects(() => f.verifier.verify(new Uint8Array(LIMITS.manifestBytes + 1), f.signature), 'size');
    await rejects(() => f.verifier.verify(f.bytes, new Uint8Array(63)), 'size');
    await rejects(() => createApplicationVerifier(syntheticPins(new Uint8Array(31))), 'size');
  }],
  ['strict schema cannot carry updater, trust, resources, URLs or commands', async () => {
    for (const field of ['trust', 'resources', 'publicKey', 'artifactUrl', 'command', 'updater']) {
      const f = await context(m => { m[field] = 'synthetic-override'; }); await rejects(f.verify, 'schema');
    }
    const kind = await context(m => { m.kind = 'updater'; }); await rejects(kind.verify, 'schema');
    const role = await context(m => { m.artifacts[0].role = 'updater'; }); await rejects(role.verify, 'artifact-role');
    const nested = await context(m => { m.repository.url = 'https://example.invalid'; }); await rejects(nested.verify, 'schema');
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) { const f = await context(m => { m.sequence = value; }); await rejects(f.verify, 'integer'); }
    const semver = await context(m => { m.version = '0.2.0+arbitrary'; }); await rejects(semver.verify, 'schema');
    for (const field of ['version', 'keyId', 'channel', 'sourceCommit']) {
      const f = await context(m => { m[field] += '\n'; }); await rejects(f.verify, 'schema');
    }
  }],
  ['artifact role, path, size, count, duplicates and migration chain are bounded', async () => {
    const mutations = [
      [m => m.artifacts.push(m.artifacts[0]), 'duplicate-artifact'],
      [m => { m.artifacts[0].name = '../escape.mjs'; }, 'schema'],
      [m => { m.artifacts[0].name = 'api.sql'; }, 'artifact-role'],
      [m => { m.artifacts[0].role = ['api']; }, 'artifact-role'],
      [m => { m.artifacts[0].role = {}; }, 'artifact-role'],
      [m => { m.artifacts[0].bytes = LIMITS.artifactBytes + 1; }, 'integer'],
      [m => { m.artifacts[0].sha256 = 'A'.repeat(64); }, 'schema'],
      [m => { m.artifacts = Array(257).fill(m.artifacts[0]); }, 'artifacts'],
      [m => { m.artifacts.forEach(a => { a.bytes = LIMITS.artifactBytes; }); m.artifacts.push({ ...m.artifacts[2], name: '0003_extra.sql' }); }, 'artifacts'],
      [m => { m.migrations[1] = m.migrations[0]; }, 'duplicate-migration'],
      [m => { m.migrations.reverse(); }, 'migration-chain'],
      [m => { m.migrations[1].sha256 = '0'.repeat(64); }, 'migration-artifact'],
      [m => { m.migrations.pop(); }, 'migration-chain'],
      [m => { m.migrations[1].artifact = 'api.mjs'; }, 'migration-artifact'],
    ];
    for (const [mutate, code] of mutations) { const f = await context(mutate); await rejects(f.verify, code); }
  }],
  ['artifacts require an opaque verified handle and exact hash and byte count', async () => {
    const f = await context(), v = await f.verify(), content = f.contents['api.mjs'];
    await rejects(() => f.verifier.verifyArtifact(structuredClone(v), 'api.mjs', content), 'unverified-manifest');
    await rejects(() => createApplicationVerifier(syntheticPins(f.signer.publicKey)).verifyArtifact(v, 'api.mjs', content), 'unverified-manifest');
    await rejects(() => f.verifier.verifyArtifact(v, 'unknown.mjs', content), 'unknown-artifact');
    await rejects(() => f.verifier.verifyArtifact(v, 'api.mjs', content.slice(1)), 'artifact-length');
    const tampered = content.slice(); tampered[0] ^= 1;
    await rejects(() => f.verifier.verifyArtifact(v, 'api.mjs', tampered), 'artifact-digest');
    await rejects(() => f.verifier.verifyArtifact(v, 'api.mjs', new Uint8Array(LIMITS.artifactBytes + 1)), 'size');
  }],
  ['snapshots survive caller mutation during verification', async () => {
    const f = await context(), pins = syntheticPins(f.signer.publicKey.slice()), verifier = createApplicationVerifier(pins);
    pins.publicKey.fill(0); pins.repository.id = 98765; pins.channel = 'wrong';
    const bytes = f.bytes.slice(), signature = f.signature.slice(), pending = verifier.verify(bytes, signature);
    bytes.fill(0); signature.fill(0); const v = await pending;
    const artifact = f.contents['api.mjs'].slice(), pendingArtifact = verifier.verifyArtifact(v, 'api.mjs', artifact); artifact.fill(0);
    assert(await sha256(await pendingArtifact) === v.manifest.artifacts[0].sha256);
  }],
  ['updates reject rollback, repeat sequence, old updater and incompatible installation', async () => {
    const f = await context(), v = await f.verify();
    for (const state of [{ ...f.state, highestSequence: 2 }, { ...f.state, highestSequence: 10 }, { ...f.state, version: '0.2.0' }]) await rejects(() => f.verifier.evaluateUpdate(v, state), 'downgrade');
    await rejects(() => f.verifier.evaluateUpdate(v, { ...f.state, updaterVersion: '0.0.9' }), 'updater-version');
    await rejects(() => f.verifier.evaluateUpdate(v, { ...f.state, version: '0.0.9' }), 'installed-compatibility');
    await rejects(() => f.verifier.evaluateUpdate(v, { ...f.state, schema: 0, ledger: [] }), 'installed-compatibility');
    await rejects(() => f.verifier.evaluateUpdate(v, { ...f.state, ledger: [{ ...f.state.ledger[0], sha256: '0'.repeat(64) }] }), 'installed-ledger');
    await rejects(() => f.verifier.evaluateUpdate(v, { ...f.state, highestSequence: NaN }), 'integer');
  }],
  ['schema and API/frontend compatibility fail closed', async () => {
    for (const mutate of [m => { m.compatibility.frontendApi.min = 3; m.compatibility.frontendApi.max = 3; }, m => { m.compatibility.apiSchema.max = 1; m.compatibility.apiSchema.min = 1; }, m => { m.compatibility.installedSchema.max = 3; }]) {
      const f = await context(mutate); await rejects(f.verify, 'compatibility');
    }
  }],
  ['code recovery requires exact trusted checkpoint and does not lower high water mark', async () => {
    const f = await context(), v = await f.verify();
    const state = { ...f.state, version: '0.3.0', schema: 2, highestSequence: 3, ledger: f.manifest.migrations.map(m => ({ id: m.id, sha256: m.sha256 })) };
    const checkpoint = { manifestSha256: v.manifestSha256, sequence: 2, version: '0.2.0', schema: 2, codeRollback: 'compatible' };
    await rejects(() => f.verifier.evaluateUpdate(v, state), 'downgrade');
    const result = f.verifier.evaluateCodeRecovery(v, state, checkpoint); assert(result.mode === 'code-recovery' && result.nextHighestSequence === 3 && result.migrations.length === 0);
    for (const patch of [{ manifestSha256: '0'.repeat(64) }, { sequence: 1 }, { version: '0.1.0' }, { schema: 1 }]) await rejects(() => f.verifier.evaluateCodeRecovery(v, state, { ...checkpoint, ...patch }), 'recovery-checkpoint');
    await rejects(() => f.verifier.evaluateCodeRecovery(v, state, { ...checkpoint, codeRollback: 'restore-required' }), 'restore-required');
    await rejects(() => f.verifier.evaluateCodeRecovery(v, { ...state, schema: 4, ledger: [...state.ledger, { id: '0003_extra.sql', sha256: '0'.repeat(64) }, { id: '0004_extra.sql', sha256: '0'.repeat(64) }] }, checkpoint), 'restore-required');
    await rejects(() => f.verifier.evaluateCodeRecovery(v, f.state, checkpoint), 'recovery-checkpoint');
  }],
];

export async function runCases() {
  const results = [];
  for (const [name, run] of cases) { await run(); results.push(name); }
  return results;
}
