import { createSessionCodec, hashPassword, verifyPassword } from "./runtime-security.ts";

type D1Result<T = unknown> = { results?: T[]; success?: boolean };
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
interface D1Database {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result[]>;
}

export interface Env {
  APP_MODE: "unconfigured" | "configured";
  ALLOWED_ORIGIN: string;
  SESSION_KEY?: string;
  DB?: D1Database;
}

type AuthMode = "google" | "local" | "both";
type BootstrapInput = { organizationName?: string; timeZone?: string; authMode?: AuthMode; adminEmail?: string; localUsername?: string; localPassword?: string; telemetryAccepted?: boolean };

const baseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const validTimeZone = (value: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } };
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function response(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(baseHeaders);
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}

function withCors(result: Response, request: Request, env: Env): Response {
  const headers = new Headers(result.headers);
  const origin = request.headers.get("origin");
  if (origin && origin === env.ALLOWED_ORIGIN) { headers.set("access-control-allow-origin", origin); headers.set("vary", "origin"); }
  return new Response(result.body, { status: result.status, headers });
}

async function parseJson<T>(request: Request): Promise<T> {
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) throw new Error("Request body is too large");
  return request.json() as Promise<T>;
}

async function setupStatus(env: Env): Promise<Response> {
  if (!env.DB) return response({ error: "D1 is not linked" }, 503);
  const installation = await env.DB.prepare("SELECT id, auth_mode AS authMode, telemetry_accepted_at AS telemetryAcceptedAt FROM installations WHERE id = ?").bind("primary").first<{ id: string; authMode: AuthMode; telemetryAcceptedAt?: string }>();
  if (!installation) return response({ configured: false });
  const settings = await env.DB.prepare("SELECT organization_name AS organizationName, subtitle, logo_url AS logoUrl, primary_color AS primaryColor, secondary_color AS secondaryColor, appearance, time_zone AS timeZone FROM organization_settings WHERE installation_id = ?").bind(installation.id).first();
  const progress = await env.DB.prepare("SELECT step, completed_at AS completedAt FROM setup_progress WHERE installation_id = ? ORDER BY step").bind(installation.id).all();
  return response({ configured: true, installation: { ...installation, telemetryAccepted: Boolean(installation.telemetryAcceptedAt) }, settings, completedSteps: progress.results ?? [] });
}

function validateBootstrap(input: BootstrapInput): string[] {
  const errors: string[] = [];
  if (!input.organizationName?.trim() || input.organizationName.trim().length > 100) errors.push("Organization name is required and must be at most 100 characters");
  if (!input.timeZone || !validTimeZone(input.timeZone)) errors.push("A valid IANA time zone is required");
  if (!input.authMode || !["google", "local", "both"].includes(input.authMode)) errors.push("Authentication mode must be google, local, or both");
  if ((input.authMode === "google" || input.authMode === "both") && (!input.adminEmail || !validEmail(input.adminEmail))) errors.push("A valid first-Admin email is required for Google sign-in");
  if ((input.authMode === "local" || input.authMode === "both") && (!input.localUsername?.trim() || (input.localPassword?.length ?? 0) < 12)) errors.push("Local sign-in requires a username and a password of at least 12 characters");
  return errors;
}

async function bootstrap(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return response({ error: "D1 is not linked" }, 503);
  const existing = await env.DB.prepare("SELECT id FROM installations WHERE id = ?").bind("primary").first();
  if (existing) return response({ error: "Installation is already configured" }, 409);
  const input = await parseJson<BootstrapInput>(request);
  const errors = validateBootstrap(input);
  if (errors.length) return response({ error: "Invalid setup", details: errors }, 400);
  const now = new Date().toISOString();
  const adminId = crypto.randomUUID();
  const mode = input.authMode!;
  const passwordHash = mode === "local" || mode === "both" ? await hashPassword(input.localPassword!) : null;
  const telemetryAcceptedAt = input.telemetryAccepted ? now : null;
  const telemetryInstallId = input.telemetryAccepted ? crypto.randomUUID() : null;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO installations (id, created_at, auth_mode, telemetry_accepted_at, telemetry_install_id) VALUES (?, ?, ?, ?, ?)").bind("primary", now, mode, telemetryAcceptedAt, telemetryInstallId),
    env.DB.prepare("INSERT INTO organization_settings (installation_id, organization_name, time_zone) VALUES (?, ?, ?)").bind("primary", input.organizationName!.trim(), input.timeZone),
    env.DB.prepare("INSERT INTO users (id, installation_id, email, local_username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?)").bind(adminId, "primary", input.adminEmail?.toLowerCase() ?? null, input.localUsername?.trim().toLowerCase() ?? null, passwordHash, now),
    env.DB.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), "primary", adminId, "installation.created", "installation", "primary", now),
  ]);
  return response({ configured: true, admin: { id: adminId, email: input.adminEmail?.toLowerCase(), localUsername: input.localUsername?.trim().toLowerCase(), role: "admin" }, telemetryAccepted: Boolean(telemetryAcceptedAt) }, 201);
}

async function localLogin(request: Request, env: Env): Promise<Response> {
  if (!env.DB || !env.SESSION_KEY) return response({ error: "Local authentication is not configured" }, 503);
  const input = await parseJson<{ username?: string; password?: string }>(request);
  if (!input.username || !input.password) return response({ error: "Username and password are required" }, 400);
  const user = await env.DB.prepare("SELECT id, role, password_hash AS passwordHash FROM users WHERE installation_id = ? AND local_username = ? AND active = 1").bind("primary", input.username.trim().toLowerCase()).first<{ id: string; role: "admin" | "operator"; passwordHash: string | null }>();
  if (!user?.passwordHash || !await verifyPassword(input.password, user.passwordHash)) return response({ error: "Invalid username or password" }, 401);
  const token = await createSessionCodec(env.SESSION_KEY).issue({ userId: user.id, role: user.role });
  return response({ ok: true, user: { id: user.id, role: user.role } }, 200, { "set-cookie": `lancerlogin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let result: Response;
    try {
      if (request.method === "OPTIONS") result = new Response(null, { status: 204, headers: { "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type" } });
      else if (url.pathname === "/health" && request.method === "GET") result = response({ ok: true, service: "lancerlogin-api", mode: env.DB ? "ready" : "unconfigured" });
      else if (url.pathname === "/setup/status" && request.method === "GET") result = await setupStatus(env);
      else if (url.pathname === "/setup/bootstrap" && request.method === "POST") result = await bootstrap(request, env);
      else if (url.pathname === "/auth/local" && request.method === "POST") result = await localLogin(request, env);
      else result = response({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      result = response({ error: "Request failed", detail: env.APP_MODE === "unconfigured" ? message : undefined }, 500);
    }
    return withCors(result, request, env);
  },
};

export default worker;
