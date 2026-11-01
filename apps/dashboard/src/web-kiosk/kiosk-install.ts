// Makes /kiosk installable as an app and able to start with no network. Only the kiosk page calls this: it links the
// web app manifest and theme color, registers the kiosk's service worker (public/kiosk-sw.js, scope /kiosk), lists
// the files this page loaded so the worker can keep them, and asks the browser to keep the kiosk's storage.

export const kioskManifestPath = "/kiosk.webmanifest";
export const kioskServiceWorkerPath = "/kiosk-sw.js";
export const kioskServiceWorkerScope = "/kiosk";
export const kioskThemeColor = "#191c1f";

/** The service worker's address. The release in it names the worker's cache, so a new deploy replaces the cache. */
export const kioskServiceWorkerUrl = (releaseVersion: string) => `${kioskServiceWorkerPath}?v=${encodeURIComponent(releaseVersion || "development")}`;

/**
 * The same-origin files this page loaded that the worker should keep: the page itself and its scripts, styles and
 * images. Never API calls (same-origin /api/... or another origin) or the worker itself.
 */
export function kioskResourceUrls(origin: string, loaded: readonly string[]) {
  const urls = new Set<string>(["/kiosk"]);
  for (const value of loaded) {
    let url: URL;
    try { url = new URL(value, origin); } catch { continue; }
    if (url.origin !== origin || url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === kioskServiceWorkerPath || url.pathname.startsWith("/__")) continue;
    if (url.pathname === "/kiosk" || url.pathname === "/kiosk/") continue;
    url.hash = "";
    urls.add(url.pathname + url.search);
  }
  return [...urls];
}

function ensureHeadElement(document: Document, selector: string, create: () => HTMLElement) {
  if (!document.head.querySelector(selector)) document.head.appendChild(create());
}

/** Links the manifest, theme color and Home Screen settings. Only the kiosk page has them, never the dashboard. */
export function linkKioskManifest(document: Document) {
  ensureHeadElement(document, 'link[rel="manifest"]', () => Object.assign(document.createElement("link"), { rel: "manifest", href: kioskManifestPath }));
  ensureHeadElement(document, 'meta[name="theme-color"]', () => Object.assign(document.createElement("meta"), { name: "theme-color", content: kioskThemeColor }));
  ensureHeadElement(document, 'link[rel="apple-touch-icon"]', () => Object.assign(document.createElement("link"), { rel: "apple-touch-icon", href: "/kiosk-apple-touch-icon.png" }));
  ensureHeadElement(document, 'meta[name="apple-mobile-web-app-capable"]', () => Object.assign(document.createElement("meta"), { name: "apple-mobile-web-app-capable", content: "yes" }));
  ensureHeadElement(document, 'meta[name="mobile-web-app-capable"]', () => Object.assign(document.createElement("meta"), { name: "mobile-web-app-capable", content: "yes" }));
  ensureHeadElement(document, 'meta[name="apple-mobile-web-app-title"]', () => Object.assign(document.createElement("meta"), { name: "apple-mobile-web-app-title", content: "Kiosk" }));
}

function loadedUrls(document: Document) {
  const urls: string[] = [];
  try { for (const entry of performance.getEntriesByType("resource")) urls.push(entry.name); } catch { /* not available */ }
  document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((script) => urls.push(script.src));
  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href], link[rel="modulepreload"][href], link[rel="manifest"][href], link[rel="apple-touch-icon"][href]').forEach((link) => urls.push(link.href));
  return urls;
}

/** Registers the kiosk's service worker and hands it the files this page already loaded. Failures are harmless. */
export async function registerKioskServiceWorker(releaseVersion: string, { document = globalThis.document, navigator = globalThis.navigator } = {}) {
  const container = navigator?.serviceWorker;
  if (!container) return undefined;
  try {
    const registration = await container.register(kioskServiceWorkerUrl(releaseVersion), { scope: kioskServiceWorkerScope });
    const ready = await container.ready;
    const worker = ready.active ?? registration.active;
    // Wait a moment so the page's own lazily loaded files are in the list too.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    worker?.postMessage({ type: "cache-urls", urls: kioskResourceUrls(document.location.origin, loadedUrls(document)) });
    return registration;
  } catch { return undefined; }
}

/** Everything the kiosk page does to be installable and to work offline. */
export function installKioskApp(releaseVersion: string) {
  linkKioskManifest(document);
  // Pairing asks too; asking on every start keeps it for kiosks paired before this release.
  void navigator.storage?.persist?.().catch(() => false);
  try { performance.setResourceTimingBufferSize?.(1_000); } catch { /* not available */ }
  void registerKioskServiceWorker(releaseVersion);
}
