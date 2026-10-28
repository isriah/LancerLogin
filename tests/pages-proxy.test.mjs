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

async function proxyRequest(url, init) {
  const module = await import(`data:text/javascript,${encodeURIComponent(buildPagesProxy("https://api.example.test"))}`);
  const forwarded = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => { forwarded.push(request.url); return new Response("upstream"); };
  try {
    const response = await module.default.fetch(new Request(url, init), { ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } });
    return { response, forwarded };
  } finally { globalThis.fetch = originalFetch; }
}

test("Pages proxy never forwards API paths to another host", async () => {
  for (const url of ["https://dash.example.test/api//attacker.example/x", "https://dash.example.test/api/\\attacker.example/x", "https://dash.example.test/api/\\\\attacker.example/x", "https://dash.example.test/api/\\/attacker.example/x", "https://dash.example.test/api///attacker.example/x"]) {
    const { response, forwarded } = await proxyRequest(url, { headers: { cookie: "lancerlogin_session=opaque" } });
    assert.equal(response.status, 400, url);
    assert.deepEqual(forwarded, [], url);
  }
  for (const url of ["https://dash.example.test/api/%2F%2Fattacker.example/x", "https://dash.example.test/api/%5Cattacker.example/x", "https://dash.example.test/api/%2f%2fattacker.example/x"]) {
    const { forwarded } = await proxyRequest(url);
    assert.equal(forwarded.length, 1, url);
    assert.equal(new URL(forwarded[0]).origin, "https://api.example.test", url);
  }
  const { forwarded } = await proxyRequest("https://dash.example.test/api");
  assert.deepEqual(forwarded, ["https://api.example.test/"]);
});

test("Pages proxy forbids framing of dashboard responses but not API responses", async () => {
  const asset = await proxyRequest("https://dash.example.test/assets/app.js");
  assert.equal(asset.response.headers.get("x-frame-options"), "DENY");
  assert.equal(asset.response.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal(await asset.response.text(), "asset");
  const api = await proxyRequest("https://dash.example.test/api/auth/session");
  assert.equal(api.response.headers.get("x-frame-options"), null);
});
