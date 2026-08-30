export interface Env {
  APP_MODE: "unconfigured" | "configured";
  ALLOWED_ORIGIN: string;
}

const responseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(responseHeaders);
    const origin = request.headers.get("origin");
    if (origin && origin === env.ALLOWED_ORIGIN) {
      headers.set("access-control-allow-origin", origin);
      headers.set("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
      headers.set("access-control-allow-headers", "authorization, content-type");
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, service: "lancerlogin-api", mode: env.APP_MODE }, { headers });
    return Response.json({ error: env.APP_MODE === "configured" ? "Not found" : "Installation is not configured" }, { status: env.APP_MODE === "configured" ? 404 : 503, headers });
  },
};

export default worker;
