import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPagesHeaders, buildPagesProxy, buildPagesRoutes, MISSING_ASSET_PAGE, PAGES_FUNCTION_ROUTES, writePagesOutput } from "../scripts/prepare-pages-proxy.mjs";

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

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";
const SHELL = ["<!doctype html><div id=root></div>", "text/html; charset=utf-8"];
const BUILT = { "/index.html": SHELL, "/assets/index-C5_UpTOL.js": ["export {};", "application/javascript"], "/assets/index-DdW3n5Qk.css": ["body{}", "text/css; charset=utf-8"], "/assets/inter-latin-400-normal-BOOGhInR.woff2": ["wOF2", "font/woff2"], "/favicon.svg": ["<svg/>", "image/svg+xml"] };
const served = ([body, type]) => new Response(body, { headers: { "content-type": type, "cache-control": REVALIDATE } });
/** Pages asset server over a Vite build: 404 for unknown paths, or (spaFallback) Pages' own 200 index.html fallback. */
function builtAssets({ spaFallback = false } = {}) {
  return (pathname) => { const file = BUILT[pathname === "/" ? "/index.html" : pathname]; return file ? served(file) : spaFallback ? served(SHELL) : new Response("Not found", { status: 404, headers: { "cache-control": REVALIDATE } }); };
}
async function serve(url, init, assets = builtAssets(), upstream = () => new Response("upstream", { headers: { "content-type": "application/json" } })) {
  const module = await import(`data:text/javascript,${encodeURIComponent(buildPagesProxy("https://api.example.test"))}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (request) => upstream(request);
  try { return await module.default.fetch(new Request(url, init), { ASSETS: { fetch: (request) => Promise.resolve(assets(new URL(request.url).pathname)) } }); }
  finally { globalThis.fetch = originalFetch; }
}

test("Pages proxy caches content-hashed build assets as immutable and keeps framing denial", async () => {
  for (const path of ["/assets/index-C5_UpTOL.js", "/assets/index-DdW3n5Qk.css", "/assets/inter-latin-400-normal-BOOGhInR.woff2"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await serve(`https://dash.example.test${path}?v=1`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), IMMUTABLE, `${method} ${path}`);
      assert.equal(response.headers.get("x-frame-options"), "DENY", `${method} ${path}`);
      assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", `${method} ${path}`);
    }
  }
  const script = await serve("https://dash.example.test/assets/index-C5_UpTOL.js", { headers: { accept: "*/*" } });
  assert.equal(await script.text(), "export {};");
});

test("Pages proxy keeps the app shell and non-asset paths revalidating", async () => {
  for (const path of ["/", "/index.html", "/favicon.svg"]) {
    const response = await serve(`https://dash.example.test${path}`, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), REVALIDATE, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
  }
  const deepLink = await serve("https://dash.example.test/settings/data", { headers: { accept: "text/html" } });
  assert.equal(await deepLink.text(), SHELL[0]);
  assert.equal(deepLink.headers.get("cache-control"), REVALIDATE);
  const pagesFallback = await serve("https://dash.example.test/settings/data", { headers: { accept: "text/html" } }, builtAssets({ spaFallback: true }));
  assert.equal(pagesFallback.headers.get("cache-control"), REVALIDATE);
});

test("Pages proxy never caches a missing build asset or its HTML fallback as immutable", async () => {
  const missing = await serve("https://dash.example.test/assets/index-Missing0.js", { headers: { accept: "*/*" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), REVALIDATE);
  const navigated = await serve("https://dash.example.test/assets/index-Missing0.js", { headers: { accept: "text/html" } });
  assert.equal(await navigated.text(), SHELL[0]);
  assert.equal(navigated.headers.get("cache-control"), REVALIDATE);
  const pagesFallback = await serve("https://dash.example.test/assets/index-Missing0.js", { headers: { accept: "*/*" } }, builtAssets({ spaFallback: true }));
  assert.equal(pagesFallback.status, 200);
  assert.equal(pagesFallback.headers.get("content-type"), SHELL[1]);
  assert.equal(pagesFallback.headers.get("cache-control"), REVALIDATE);
  const posted = await serve("https://dash.example.test/assets/index-C5_UpTOL.js", { method: "POST", body: "x" });
  assert.equal(posted.headers.get("cache-control"), REVALIDATE);
});

test("Pages proxy leaves API and release responses' caching to their origin", async () => {
  for (const path of ["/api/auth/session", "/api/assets/index-C5_UpTOL.js"]) {
    const response = await serve(`https://dash.example.test${path}`, undefined, builtAssets(), () => new Response("{}", { headers: { "content-type": "application/javascript", "cache-control": "no-store" } }));
    assert.equal(response.headers.get("cache-control"), "no-store", path);
  }
  const uncached = await serve("https://dash.example.test/api/assets/index-C5_UpTOL.js");
  assert.equal(uncached.headers.get("cache-control"), null);
  const release = await serve("https://dash.example.test/__lancerlogin-release");
  assert.equal(release.headers.get("cache-control"), "no-store");
});

test("Pages routes send only the proxy's own paths to the function", () => {
  const routes = JSON.parse(buildPagesRoutes());
  assert.deepEqual(routes, { version: 1, include: ["/api", "/api/*", "/__lancerlogin-release"], exclude: [] });
  assert.deepEqual(routes.include, [...PAGES_FUNCTION_ROUTES]);
  // The rules wrangler pages deploy enforces before upload.
  assert.ok(routes.include.length >= 1 && routes.include.length + routes.exclude.length <= 100);
  for (const rule of [...routes.include, ...routes.exclude]) { assert.ok(rule.startsWith("/"), rule); assert.ok(rule.length <= 100, rule); }
  for (const splat of routes.include.filter((rule) => rule.endsWith("/*"))) {
    for (const rule of routes.include) if (rule !== splat) assert.ok(!rule.startsWith(splat.slice(0, -1)), `${rule} overlaps ${splat}`);
  }
  assert.ok(!routes.include.includes("/*") && !routes.include.some((rule) => rule.startsWith("/assets") || rule.startsWith("/settings")));
});

/** Pages' _routes.json matching: a trailing /* matches anything below that prefix; other rules match exactly. */
const routed = (pathname) => PAGES_FUNCTION_ROUTES.some((rule) => rule.endsWith("/*") ? pathname.startsWith(rule.slice(0, -1)) : pathname === rule);

test("Every path the proxy answers itself is routed to the function, and nothing else", async () => {
  for (const path of ["/api", "/api/", "/api/auth/session", "/api/assets/index-C5_UpTOL.js", "/__lancerlogin-release"]) {
    assert.ok(routed(path), path);
    let assetFetches = 0;
    const response = await serve(`https://dash.example.test${path}`, undefined, (pathname) => { assetFetches += 1; return builtAssets()(pathname); });
    assert.equal(assetFetches, 0, path);
    assert.notEqual(response.status, 404, path);
  }
  for (const path of ["/", "/index.html", "/settings/visits", "/kiosks", "/assets/index-C5_UpTOL.js", "/kiosk-sw.js", "/kiosk.webmanifest", "/favicon.svg", "/apiary", "/__lancerlogin-release/x"]) {
    assert.ok(!routed(path), path);
    let assetFetches = 0;
    await serve(`https://dash.example.test${path}`, { headers: { accept: "text/html" } }, (pathname) => { assetFetches += 1; return builtAssets()(pathname); });
    assert.ok(assetFetches >= 1, `${path} is only a static asset or the app shell`);
  }
});

/** Applies _headers the way Pages does: every matching block, a trailing * matching any suffix. */
function pagesHeaders(source, pathname) {
  const headers = new Headers();
  let matches = false;
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    if (!line.startsWith(" ")) { matches = line.endsWith("*") ? pathname.startsWith(line.slice(0, -1)) : pathname === line; continue; }
    if (matches) { const [name, ...value] = line.trim().split(":"); headers.set(name, value.join(":").trim()); }
  }
  return headers;
}

test("Pages _headers give static responses the proxy's framing denial and caching", async () => {
  const source = buildPagesHeaders();
  for (const path of ["/", "/index.html", "/settings/data", "/favicon.svg", "/assets/index-C5_UpTOL.js", "/assets/inter-latin-400-normal-BOOGhInR.woff2", "/kiosk-sw.js", "/kiosk.webmanifest"]) {
    const assets = { ...BUILT, "/kiosk-sw.js": ["self.x=1", "application/javascript"], "/kiosk.webmanifest": ["{}", "application/manifest+json"] };
    const proxied = await serve(`https://dash.example.test${path}`, { headers: { accept: "text/html" } }, (pathname) => { const file = assets[pathname === "/" ? "/index.html" : pathname]; return file ? served(file) : new Response("Not found", { status: 404, headers: { "cache-control": REVALIDATE } }); });
    const fromPages = pagesHeaders(source, path);
    for (const name of ["content-security-policy", "x-frame-options"]) assert.equal(fromPages.get(name), proxied.headers.get(name), `${name} ${path}`);
    assert.equal(fromPages.get("cache-control") ?? REVALIDATE, proxied.headers.get("cache-control"), path);
  }
});

test("Pages output keeps the single-page fallback and makes a missing build asset a 404", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-pages-"));
  try {
    await writePagesOutput(directory, "https://api.example.test", "2.1.0");
    assert.deepEqual((await readdir(directory)).sort(), ["_headers", "_routes.json", "_worker.js", "assets"]);
    assert.deepEqual(await readdir(join(directory, "assets")), ["404.html"]);
    assert.equal(await readFile(join(directory, "_worker.js"), "utf8"), buildPagesProxy("https://api.example.test", "2.1.0"));
    assert.equal(await readFile(join(directory, "_routes.json"), "utf8"), buildPagesRoutes());
    assert.equal(await readFile(join(directory, "_headers"), "utf8"), buildPagesHeaders());
    assert.equal(await readFile(join(directory, "assets", "404.html"), "utf8"), MISSING_ASSET_PAGE);
    // A top-level 404.html would turn off Pages' index.html fallback for deep links such as /settings/visits.
    assert.ok(!(await readdir(directory)).includes("404.html"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("The prepare-pages-proxy command writes the Pages files beside _worker.js", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-pages-cli-"));
  try {
    const script = fileURLToPath(new URL("../scripts/prepare-pages-proxy.mjs", import.meta.url));
    await promisify(execFile)(process.execPath, [script, "https://api.example.test", join(directory, "dist", "_worker.js")]);
    assert.deepEqual((await readdir(join(directory, "dist"))).sort(), ["_headers", "_routes.json", "_worker.js", "assets"]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "dist", "_routes.json"), "utf8")).include, [...PAGES_FUNCTION_ROUTES]);
    await assert.rejects(promisify(execFile)(process.execPath, [script, "https://api.example.test", join(directory, "proxy.js")]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
