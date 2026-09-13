import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { cases, fixture, syntheticPins, webSigner } from './cases.mjs';
import { createApplicationVerifier, signedBytes } from './verifier.mjs';

for (const [name, run] of cases) test(name, run);

test('Node native crypto and portable WebCrypto agree in both directions', async () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = new Uint8Array(Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url'));
  const native = { publicKey, sign: bytes => new Uint8Array(sign(null, bytes, pair.privateKey)) };
  const f = await fixture(native);
  await createApplicationVerifier(syntheticPins(publicKey)).verify(f.bytes, f.signature);
  const web = await webSigner(), other = await fixture(web);
  assert.equal(verify(null, signedBytes(other.bytes), { key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(web.publicKey).toString('base64url') }, format: 'jwk' }, other.signature), true);
});
