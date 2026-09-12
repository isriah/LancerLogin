import test from "node:test";
import assert from "node:assert/strict";
import { buildPagesProxy } from "../scripts/prepare-pages-proxy.mjs";

test("Pages proxy keeps dashboard authentication same-origin", async () => {
  const source = buildPagesProxy("https://example-club-api.example.workers.dev/");
  assert.match(source, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /env\.ASSETS\.fetch\(request\)/);
  assert.doesNotMatch(source, /cookie|authorization/i);
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  let upstream;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => { upstream = request; return new Response("ok", { headers: { "set-cookie": "session=opaque; Secure" } }); };
  try {
    const request = new Request("https://example-club-dashboard.pages.dev/api/auth/session?fresh=1", { headers: { cookie: "session=opaque", origin: "https://example-club-dashboard.pages.dev" } });
    const response = await module.default.fetch(request, { ASSETS: { fetch: () => new Response("asset") } });
    assert.equal(upstream.url, "https://example-club-api.example.workers.dev/auth/session?fresh=1");
    assert.equal(upstream.headers.get("cookie"), "session=opaque");
    assert.equal(response.headers.get("set-cookie"), "session=opaque; Secure");
  } finally { globalThis.fetch = originalFetch; }
});

test("Pages proxy rejects non-origin and non-HTTPS upstream values", () => {
  assert.throws(() => buildPagesProxy("http://api.example.test"), /HTTPS origin/);
  assert.throws(() => buildPagesProxy("https://api.example.test/path"), /HTTPS origin/);
  assert.throws(() => buildPagesProxy("https://user:secret@api.example.test/"), /HTTPS origin/);
});

test("Pages proxy serves the app shell for deep-link navigation", async () => {
  const source = buildPagesProxy("https://api.example.test");
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const requested = [];
  const response = await module.default.fetch(
    new Request("https://dashboard.example.test/settings/data", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch(request) {
          requested.push(new URL(request.url).pathname);
          return Promise.resolve(requested.length === 1 ? new Response("missing", { status: 404 }) : new Response("app shell"));
        }
      }
    }
  );
  assert.deepEqual(requested, ["/settings/data", "/index.html"]);
  assert.equal(await response.text(), "app shell");
});
