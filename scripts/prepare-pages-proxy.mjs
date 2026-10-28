import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseReleaseVersion } from "../packages/shared/src/release-policy.mjs";

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
      return fetch(new Request(target, request));
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || request.method !== "GET" || !request.headers.get("accept")?.includes("text/html")) return denyFraming(asset);
    const shell = new URL("/index.html", incoming.origin);
    return denyFraming(await env.ASSETS.fetch(new Request(shell, request)));
  },
};
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

async function main() {
  const [apiUrl, output = "apps/dashboard/dist/_worker.js"] = process.argv.slice(2);
  if (!apiUrl) throw new Error("Usage: prepare-pages-proxy.mjs <worker-api-origin> [output]");
  await mkdir(dirname(output), { recursive: true });
  const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  await writeFile(output, buildPagesProxy(apiUrl, packageVersion), { mode: 0o600 });
}

if (process.argv[1]?.endsWith("prepare-pages-proxy.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
