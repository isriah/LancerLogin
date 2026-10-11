import { can } from "../../../packages/shared/src/policy.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const cors = (response, origin, allowedOrigins) => {
  const headers = new Headers(response.headers);
  if (origin && allowedOrigins.has(origin)) { headers.set("access-control-allow-origin", origin); headers.set("vary", "origin"); headers.set("access-control-allow-headers", "authorization, content-type"); }
  return new Response(response.body, { status: response.status, headers });
};

export function createWorker({ authenticate = async () => undefined, allowedOrigins = [] } = {}) {
  const originSet = new Set(allowedOrigins);
  return {
    async fetch(request) {
      const url = new URL(request.url); const origin = request.headers.get("origin");
      if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin, originSet);
      if (url.pathname === "/health") return cors(json({ ok: true, service: "lancerlogin-api", mode: "mock" }), origin, originSet);
      const principal = await authenticate(request);
      if (!principal) return cors(json({ error: "Unauthorized" }, 401), origin, originSet);
      const route = { "/admin/meetings": "manage-meetings", "/admin/attendance": "manage-attendance", "/admin/integrations": "manage-integrations", "/admin/branding": "manage-branding" }[url.pathname];
      if (!route) return cors(json({ error: "Not found" }, 404), origin, originSet);
      if (!can(principal.role, route)) return cors(json({ error: "Forbidden" }, 403), origin, originSet);
      return cors(json({ ok: true, actor: principal.userId, capability: route }), origin, originSet);
    },
  };
}
