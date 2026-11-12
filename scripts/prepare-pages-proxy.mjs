import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseReleaseVersion } from "../packages/shared/src/release-policy.mjs";

/** The Pages project's service binding to the installation's Worker. A proxy without it falls back to fetch. */
export const PAGES_API_BINDING = "API";

/** Adds the binding to the production environment, leaving the project's other settings alone. It applies from the next Pages deployment. */
export async function bindPagesApi({ accountOrigin, headers, project, worker, request = fetch }) {
  const body = { deployment_configs: { production: { services: { [PAGES_API_BINDING]: { service: worker, environment: "production" } } } } };
  const response = await request(`${accountOrigin}/pages/projects/${project}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`pages_api_binding_failed_${response.status}`);
}

export function buildPagesProxy(apiUrl, releaseVersion) {
  const upstream = new URL(apiUrl);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/") throw new Error("Worker API URL must be an HTTPS origin");
  const origin = upstream.origin;
  if (releaseVersion !== undefined && (!parseReleaseVersion(releaseVersion) || releaseVersion.startsWith("v"))) throw new Error("Invalid release version");
  return `const API_ORIGIN = ${JSON.stringify(origin)};
const RELEASE_VERSION = ${JSON.stringify(releaseVersion ?? "development")};
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname === "/__lancerlogin-release" && request.method === "GET") return Response.json({ releaseVersion: RELEASE_VERSION }, { headers: { "cache-control": "no-store" } });
    if (incoming.pathname === "/api" || incoming.pathname.startsWith("/api/")) {
      const path = incoming.pathname.slice(4) || "/";
      if (path.startsWith("//")) return badRequest();
      const target = new URL(API_ORIGIN);
      target.pathname = path;
      target.search = incoming.search;
      if (target.origin !== API_ORIGIN) return badRequest();
      const forwarded = new Request(target, request);
      // Through the binding the Worker sees each visitor's address in CF-Connecting-IP, which its per-client limits read.
      // A fetch to workers.dev crosses zones, so Cloudflare replaces it with one address shared by every visitor.
      return env.${PAGES_API_BINDING} ? env.${PAGES_API_BINDING}.fetch(forwarded) : fetch(forwarded);
    }
    // _routes.json sends only the paths above to this function on Pages; static files and deep links are served by Pages
    // itself, with _headers. The asset handling below matches that, for local runs and a deployment without _routes.json.
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || request.method !== "GET" || !request.headers.get("accept")?.includes("text/html")) return cacheHashedAsset(incoming.pathname, request.method, denyFraming(asset));
    const shell = new URL("/index.html", incoming.origin);
    return denyFraming(await env.ASSETS.fetch(new Request(shell, request)));
  },
};
// Vite writes only content-hashed files under /assets/. HTML there is Pages' SPA fallback for a missing file, never a real asset.
// The web kiosk's service worker and manifest keep their names across deploys, so browsers check them on every load.
const REVALIDATED_FILES = new Set(["/kiosk-sw.js", "/kiosk.webmanifest"]);
function cacheHashedAsset(pathname, method, response) {
  if (response.status !== 200 || (method !== "GET" && method !== "HEAD")) return response;
  if (pathname.startsWith("/assets/") && !response.headers.get("content-type")?.includes("text/html")) response.headers.set("cache-control", "public, max-age=31536000, immutable");
  else if (REVALIDATED_FILES.has(pathname)) response.headers.set("cache-control", "no-cache");
  return response;
}
function badRequest() {
  return new Response("Bad request", { status: 400, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
}
function denyFraming(response) {
  const framed = new Response(response.body, response);
  framed.headers.set("content-security-policy", "frame-ancestors 'none'");
  framed.headers.set("x-frame-options", "DENY");
  return framed;
}
`;
}

// Pages runs _worker.js for every path that _routes.json includes, and each run counts against the Workers Free plan's
// daily request allowance, so it includes only the paths the proxy answers itself. Everything else is a static request:
// free, and handled by Pages, including its single-page fallback to index.html for dashboard deep links.
export const PAGES_FUNCTION_ROUTES = Object.freeze(["/api", "/api/*", "/__lancerlogin-release"]);

export function buildPagesRoutes() {
  return `${JSON.stringify({ version: 1, include: PAGES_FUNCTION_ROUTES, exclude: [] }, null, 2)}\n`;
}

// Pages applies _headers only to the static responses that bypass _worker.js; they get the same framing denial and
// caching as the proxy gives them. Pages replaces Cache-Control with no-store on a 404.
export function buildPagesHeaders() {
  return `/*
  Content-Security-Policy: frame-ancestors 'none'
  X-Frame-Options: DENY
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/kiosk-sw.js
  Cache-Control: no-cache
/kiosk.webmanifest
  Cache-Control: no-cache
`;
}

// Pages serves the nearest 404.html for a missing file, else index.html. This one makes a missing build asset a 404,
// so a stale chunk name never gets the app shell cached as an immutable asset. index.html still answers deep links.
export const MISSING_ASSET_PAGE = "<!doctype html><meta charset=utf-8><title>Not found</title><p>Not found</p>\n";

/** Writes _worker.js and the Pages files beside it: _routes.json, _headers and assets/404.html. */
export async function writePagesOutput(directory, apiUrl, releaseVersion) {
  const proxy = buildPagesProxy(apiUrl, releaseVersion);
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(directory, "_worker.js"), proxy, { mode: 0o600 });
  await writeFile(join(directory, "_routes.json"), buildPagesRoutes(), { mode: 0o600 });
  await writeFile(join(directory, "_headers"), buildPagesHeaders(), { mode: 0o600 });
  await writeFile(join(directory, "assets", "404.html"), MISSING_ASSET_PAGE, { mode: 0o600 });
}

async function main() {
  const [apiUrl, output = "apps/dashboard/dist/_worker.js"] = process.argv.slice(2);
  if (!apiUrl) throw new Error("Usage: prepare-pages-proxy.mjs <worker-api-origin> [output]");
  if (!output.endsWith("_worker.js")) throw new Error("The output must be a _worker.js file in the Pages output directory");
  const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  await writePagesOutput(dirname(output), apiUrl, packageVersion);
}

if (process.argv[1]?.endsWith("prepare-pages-proxy.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
