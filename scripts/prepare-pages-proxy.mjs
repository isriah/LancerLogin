import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

export function buildPagesProxy(apiUrl) {
  const upstream = new URL(apiUrl);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== "/") throw new Error("Worker API URL must be an HTTPS origin");
  const origin = upstream.origin;
  const entry = `import { HOURS_ASSERTION_HEADER, trustedPagesSource, readHoursProxyBody, createHoursAssertion, HoursProxyError } from ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), '../packages/shared/src/hours-proxy.ts').replaceAll('\\', '/'))};
import { DOCUMENTATION_ASSERTION_HEADER, readDocumentationProxyBody, createDocumentationAssertion, DocumentationProxyError } from ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), '../packages/shared/src/documentation-proxy.ts').replaceAll('\\', '/'))};
import { UPLOAD_ASSERTION_HEADER, readUploadProxyBody, createUploadAssertion, UploadProxyError } from ${JSON.stringify(resolve(dirname(fileURLToPath(import.meta.url)), '../packages/shared/src/upload-proxy.ts').replaceAll('\\', '/'))};
const API_ORIGIN = ${JSON.stringify(origin)};
export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.pathname === "/api" || incoming.pathname.startsWith("/api/")) {
      const target = new URL(incoming.pathname.slice(4) || "/", API_ORIGIN);
      target.search = incoming.search;
      if (target.pathname.startsWith("/public/hours/") || target.pathname.startsWith("/public/documentation/")) {
        const documentation=target.pathname.startsWith("/public/documentation/");
        const upload=target.pathname==="/public/documentation/uploads" || target.pathname.startsWith("/public/documentation/uploads/");
        const assertionHeader=upload?UPLOAD_ASSERTION_HEADER:documentation?DOCUMENTATION_ASSERTION_HEADER:HOURS_ASSERTION_HEADER;
        const readBody=upload?readUploadProxyBody:documentation?readDocumentationProxyBody:readHoursProxyBody;
        const createAssertion=upload?createUploadAssertion:documentation?createDocumentationAssertion:createHoursAssertion;
        const headers = new Headers(request.headers);
        headers.delete(HOURS_ASSERTION_HEADER);headers.delete(DOCUMENTATION_ASSERTION_HEADER);headers.delete(UPLOAD_ASSERTION_HEADER);
        if (["POST","PUT"].includes(request.method) && headers.get("origin") !== incoming.origin) return Response.json({error:"Public submissions require the configured form origin"},{status:403,headers:{"cache-control":"no-store"}});
        try {
          const body = await readBody(request);
          headers.delete("content-length");
          const upstream = new Request(target, {method:request.method,headers,redirect:"manual",...(["POST","PUT"].includes(request.method)?{body}: {})});
          const source = trustedPagesSource(request);
          if (source && typeof env.HOURS_PROXY_KEY === "string") {
            try { upstream.headers.set(assertionHeader, await createAssertion(upstream, env.HOURS_PROXY_KEY, incoming.origin, API_ORIGIN, source, body)); } catch { /* Invalid setup uses restrictive fallback. */ }
          }
          const response = await fetch(upstream);
          const outgoing = new Headers(response.headers);outgoing.delete(HOURS_ASSERTION_HEADER);outgoing.delete(DOCUMENTATION_ASSERTION_HEADER);outgoing.delete(UPLOAD_ASSERTION_HEADER);outgoing.set("cache-control","no-store");
          return new Response(response.body,{status:response.status,statusText:response.statusText,headers:outgoing});
        } catch(error) {
          return Response.json({error:(error instanceof HoursProxyError || error instanceof DocumentationProxyError || error instanceof UploadProxyError)?error.message:(documentation?"Public Documentation transport is unavailable":"Public hour transport is unavailable")},{status:(error instanceof HoursProxyError || error instanceof DocumentationProxyError || error instanceof UploadProxyError)?error.status:503,headers:{"cache-control":"no-store"}});
        }
      }
      return fetch(new Request(target, request));
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404 || request.method !== "GET" || !request.headers.get("accept")?.includes("text/html")) return asset;
    const shell = new URL("/index.html", incoming.origin);
    return env.ASSETS.fetch(new Request(shell, request));
  },
};
`;
  return buildSync({stdin:{contents:entry,resolveDir:process.cwd(),loader:"ts"},bundle:true,format:"esm",platform:"browser",write:false}).outputFiles[0].text;
}

async function main() {
  const [apiUrl, output = "apps/dashboard/dist/_worker.js"] = process.argv.slice(2);
  if (!apiUrl) throw new Error("Usage: prepare-pages-proxy.mjs <worker-api-origin> [output]");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, buildPagesProxy(apiUrl), { mode: 0o600 });
}

if (process.argv[1]?.endsWith("prepare-pages-proxy.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
