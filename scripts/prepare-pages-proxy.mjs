import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function buildPagesProxy(apiUrl) {
  const upstream = new URL(apiUrl);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/") throw new Error("Worker API URL must be an HTTPS origin");
  const origin = upstream.origin;
  return `const API_ORIGIN = ${JSON.stringify(origin)};
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname === "/api" || incoming.pathname.startsWith("/api/")) {
      const target = new URL(incoming.pathname.slice(4) || "/", API_ORIGIN);
      target.search = incoming.search;
      return fetch(new Request(target, request));
    }
    return env.ASSETS.fetch(request);
  },
};
`;
}

async function main() {
  const [apiUrl, output = "apps/dashboard/dist/_worker.js"] = process.argv.slice(2);
  if (!apiUrl) throw new Error("Usage: prepare-pages-proxy.mjs <worker-api-origin> [output]");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, buildPagesProxy(apiUrl), { mode: 0o600 });
}

if (process.argv[1]?.endsWith("prepare-pages-proxy.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
