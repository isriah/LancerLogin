// quick-check: covers apps/api/src/report-data-cache.ts
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Cloudflare ends a request when its client goes away or it runs out of CPU. A promise that request created can then
// never settle, and another request that awaits it fails. A cache shared by every request on the isolate must not hand
// such a promise out, or one ended request fails every later one until the entry expires.
test("a load whose request ended does not fail later requests", async () => {
  const bundled = await build({ stdin: { contents: `import { ReportDataCache } from './apps/api/src/report-data-cache.ts';
    const cache = new ReportDataCache(); const database = {}; let loads = 0, started = 0;
    export default { async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/started') return Response.json({ started, loads });
      const wait = Number(url.searchParams.get('wait') ?? 0);
      const reading = () => cache.read(database, 'all', async () => 1, async () => { started++; if (wait) await scheduler.wait(wait); return ++loads; });
      // Answering without waiting for the load ends this request while the load is still running.
      if (url.pathname === '/abandon') { reading().catch(() => undefined); await scheduler.wait(20); return new Response('left'); }
      try {
        const value = await reading();
        return Response.json({ value });
      } catch (error) { return Response.json({ error: String(error && error.message || error) }, { status: 500 }); }
    } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-08-01" }));
  try {
    const origin = String(await runtime.ready).replace(/\/$/, "");
    // The first request starts a slow load and ends before the load finishes.
    assert.equal(await (await fetch(`${origin}/abandon?wait=2000`)).text(), "left");
    assert.deepEqual(await (await fetch(`${origin}/started`)).json(), { started: 1, loads: 0 });
    for (let call = 0; call < 3; call++) {
      const result = await fetch(`${origin}/read`, { signal: AbortSignal.timeout(10_000) });
      assert.deepEqual([result.status, await result.json()], [200, { value: 1 }], `call ${call + 1}`);
    }
    assert.equal((await (await fetch(`${origin}/started`)).json()).started, 2, "the later request loads for itself, once");
  } finally { await runtime.dispose(); }
});
