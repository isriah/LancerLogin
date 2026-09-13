// Usage: node experiments/release-trust/local-workerd.mjs <installed miniflare path>
// Generates synthetic keys in memory. Never reads credentials or writes key files.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture, syntheticPins } from './cases.mjs';
import { createApplicationVerifier, sha256, signedBytes } from './verifier.mjs';

if (!process.argv[2]) throw new Error('Pass the installed Miniflare package path.');
const require = createRequire(import.meta.url);
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require(resolve(process.argv[2]));
const root = fileURLToPath(new URL('.', import.meta.url));
let outbound = 0;
const runtime = new Miniflare(convertV4MiniflareOptions({
  name: 'release-trust-local', modulesRoot: resolve(root, '../..'),
  modules: ['local-worker.mjs', 'verifier.mjs', 'cases.mjs', '../../packages/shared/src/updater/application-release.mjs'].map(path => ({ type: 'ESModule', path: resolve(root, path) })),
  compatibilityDate: '2026-09-04', log: new Log(LogLevel.ERROR), telemetry: { enabled: false },
  outboundService: () => { outbound++; throw new Error('Network forbidden in release trust tests.'); },
}));
try {
  const response = await runtime.dispatchFetch('https://example.invalid/cases');
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.cases.length, 12);
  const pair = generateKeyPairSync('ed25519');
  const publicKey = new Uint8Array(Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'));
  const native = { publicKey, sign: bytes => new Uint8Array(sign(null, bytes, pair.privateKey)) };
  const f = await fixture(native);
  const verified = await runtime.dispatchFetch('https://example.invalid/verify-native', { method: 'POST', body: JSON.stringify({ publicKey: [...publicKey], bytes: [...f.bytes], signature: [...f.signature] }) });
  assert.equal(verified.status, 200); assert.equal((await verified.json()).sha256, await sha256(f.bytes));
  const fromWorker = await (await runtime.dispatchFetch('https://example.invalid/signed-fixture')).json();
  await createApplicationVerifier(syntheticPins(new Uint8Array(fromWorker.publicKey))).verify(new Uint8Array(fromWorker.bytes), new Uint8Array(fromWorker.signature));
  assert.equal(verify(null, signedBytes(new Uint8Array(fromWorker.bytes)), { key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(fromWorker.publicKey).toString('base64url') }, format: 'jwk' }, new Uint8Array(fromWorker.signature)), true);
  assert.equal(outbound, 0);
  console.log(JSON.stringify({ runtime: 'actual local workerd; no deployment', casesPassed: result.cases.length, nodeNativeToWorkerd: true, workerdToNodeNativeAndWebCrypto: true, outboundRequests: outbound }));
} finally { await runtime.dispose(); }
