// LancerLogin web kiosk service worker. Only the /kiosk page registers it, with scope /kiosk, so the kiosk loads with
// no network. The dashboard's own pages are never served from it.
// - The /kiosk page: network first, so a new deploy shows at once; the cached copy when the network fails.
// - Content-hashed /assets/* files: cache first. A new deploy has new file names, so a cached file never goes stale.
// - Other files the kiosk page loads from this site (icons, the manifest, and the development server's modules):
//   network first, with the cached copy as the fallback.
// - Never cached: API requests (same-origin /api/... or another origin), anything with an Authorization header,
//   anything but GET, and fetch() calls from the page (they have no request destination).
// Cached files are matched by address alone (ignoring Vary), since only this site's own files are kept.
// The cache name carries this file's version and the dashboard release the page registered it with (`?v=`), so a new
// deploy installs a new worker that replaces the old cache.
const workerVersion = 1;
const cachePrefix = "lancerlogin-kiosk-";
const releaseVersion = new URL(self.location.href).searchParams.get("v") || "development";
const cacheName = `${cachePrefix}v${workerVersion}-${releaseVersion.replace(/[^\w.+-]/g, "_").slice(0, 60)}`;
const kioskPage = "/kiosk";
const pageTimeoutMs = 5000;

const isKioskPath = (pathname) => pathname === kioskPage || pathname === `${kioskPage}/`;

/**
 * How to answer a request: "page" (the kiosk page, network first), "asset" (cache first), "static" (network first,
 * cached fallback) or "pass" (leave it to the network, never cached). `request` needs method, url, mode, destination
 * and headers; `origin` is this site's origin.
 */
function kioskSwRoute(request, origin) {
  if (request.method !== "GET") return "pass";
  if (request.headers && typeof request.headers.has === "function" ? request.headers.has("authorization") : request.headers?.authorization) return "pass";
  let url;
  try { url = new URL(request.url); } catch { return "pass"; }
  if (url.origin !== origin) return "pass";
  if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/kiosk-sw.js" || url.pathname.startsWith("/__")) return "pass";
  if (request.mode === "navigate") return isKioskPath(url.pathname) ? "page" : "pass";
  // fetch() and XHR calls have no destination: the kiosk's API calls, whatever origin the API is on.
  if (!request.destination) return "pass";
  return url.pathname.startsWith("/assets/") ? "asset" : "static";
}

/** A response worth keeping: a complete same-origin answer, and never the HTML fallback for a missing asset. */
function cacheable(response, route) {
  if (!response || response.status !== 200 || response.type === "opaque" || response.type === "error") return false;
  const type = response.headers.get("content-type") || "";
  if (route === "page") return type.includes("text/html");
  return !(route === "asset" && type.includes("text/html"));
}

const pageRequest = () => new Request(kioskPage, { headers: { accept: "text/html" }, credentials: "same-origin" });

async function put(key, response, route) {
  if (!cacheable(response, route)) return;
  const cache = await caches.open(cacheName);
  await cache.put(key, response);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function answerPage(request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(kioskPage, { ignoreVary: true });
  const network = fetch(request);
  try {
    // Without a cached copy, wait for the network however long it takes.
    const response = await (cached ? withTimeout(network, pageTimeoutMs) : network);
    if (cacheable(response, "page")) await cache.put(kioskPage, response.clone());
    return response;
  } catch (error) {
    if (cached) { network.then((response) => put(kioskPage, response, "page")).catch(() => undefined); return cached; }
    throw error;
  }
}

async function answerAsset(request) {
  const cached = await caches.match(request, { cacheName, ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  await put(request, response.clone(), "asset").catch(() => undefined);
  return response;
}

async function answerStatic(request) {
  try {
    const response = await fetch(request);
    await put(request, response.clone(), "static").catch(() => undefined);
    return response;
  } catch (error) {
    const cached = await caches.match(request, { cacheName, ignoreVary: true });
    if (cached) return cached;
    throw error;
  }
}

/** Requests from a page other than the kiosk (the dashboard's /kiosks page shares the /kiosk prefix) go to the network. */
async function fromKioskPage(event) {
  if (!event.clientId) return true;
  const client = await self.clients.get(event.clientId);
  return !client || isKioskPath(new URL(client.url).pathname);
}

/**
 * The page lists the files it loaded before this worker controlled it; keep the ones missing from the cache, and drop
 * cached /assets/ files the page no longer uses (an earlier deploy's).
 */
async function cacheUrls(urls) {
  const cache = await caches.open(cacheName);
  const wanted = new Set();
  for (const value of urls.slice(0, 1000)) {
    let url;
    try { url = new URL(value, self.location.origin); } catch { continue; }
    if (url.origin !== self.location.origin) continue;
    const isPage = isKioskPath(url.pathname);
    const route = isPage ? "page" : kioskSwRoute({ method: "GET", url: url.href, mode: "no-cors", destination: "script", headers: {} }, self.location.origin);
    if (route === "pass") continue;
    const key = isPage ? kioskPage : url.href;
    wanted.add(key);
    if (await cache.match(key, { ignoreVary: true })) continue;
    try { await put(key, await fetch(isPage ? pageRequest() : new Request(url.href, { credentials: "same-origin" })), route); } catch { /* tried again on the next message */ }
  }
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/") && !wanted.has(url.href)) await cache.delete(request);
  }
}

if (typeof self.addEventListener === "function") {
  self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
      try { await put(kioskPage, await fetch(pageRequest()), "page"); } catch { /* cached on the next load */ }
      await self.skipWaiting();
    })());
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
      await self.clients.claim();
    })());
  });

  self.addEventListener("fetch", (event) => {
    const route = kioskSwRoute(event.request, self.location.origin);
    if (route === "pass") return;
    if (route === "page") { event.respondWith(answerPage(event.request)); return; }
    event.respondWith((async () => {
      if (!await fromKioskPage(event)) return fetch(event.request);
      return route === "asset" ? answerAsset(event.request) : answerStatic(event.request);
    })());
  });

  self.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === "cache-urls" && Array.isArray(data.urls)) event.waitUntil(cacheUrls(data.urls.filter((url) => typeof url === "string")));
  });
}
