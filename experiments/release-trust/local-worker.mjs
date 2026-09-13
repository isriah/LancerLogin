// Local test harness only. No deploy configuration or provider bindings.
import { createApplicationVerifier } from './verifier.mjs';
import { fixture, runCases, syntheticPins, webSigner } from './cases.mjs';

export default {
  async fetch(request) {
    const route = new URL(request.url).pathname;
    if (route === '/cases') return Response.json({ cases: await runCases(), runtime: 'local workerd' });
    if (route === '/signed-fixture') {
      const signer = await webSigner(), f = await fixture(signer);
      return Response.json({ publicKey: [...signer.publicKey], bytes: [...f.bytes], signature: [...f.signature] });
    }
    if (route === '/verify-native') {
      const body = await request.json();
      const verifier = createApplicationVerifier(syntheticPins(new Uint8Array(body.publicKey)));
      const verified = await verifier.verify(new Uint8Array(body.bytes), new Uint8Array(body.signature));
      return Response.json({ verified: true, sha256: verified.manifestSha256 });
    }
    return new Response(null, { status: 404 });
  },
};
