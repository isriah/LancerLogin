type D1Result<T = unknown> = { results?: T[]; success?: boolean; meta?: { changes?: number } };
interface D1Statement { bind(...values: unknown[]): D1Statement; first<T = unknown>(): Promise<T | null>; all<T = unknown>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
interface D1Database { prepare(query: string): D1Statement; batch(statements: D1Statement[]): Promise<D1Result[]>; }
interface RateLimit { limit(input: { key: string }): Promise<{ success: boolean }>; }

export interface Env {
  DB?: D1Database;
  GLOBAL_LIMITER?: RateLimit;
  INSTALL_LIMITER?: RateLimit;
  INSTALL_ID_PEPPER?: string;
  ADMIN_BEARER_TOKEN?: string;
  RETENTION_DAYS?: string;
  MAX_DAILY_NEW_INSTALLS?: string;
}

export type TelemetryReport = {
  installId: string;
  releaseVersion: string;
  activeKioskCount: 0 | 1;
  errorCategory?: "worker-internal" | "integration-upstream";
  metro?: string;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const reportKeys = new Set(["installId", "releaseVersion", "activeKioskCount", "errorCategory", "metro"]);
const deletionKeys = new Set(["installId"]);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const releaseVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,20})?$/;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const ipv6 = /^(?=.*:)[0-9a-f:]+$/i;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff", ...headers } });
}

function integerSetting(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new HttpError(503, `${name} is invalid`);
  return parsed;
}

export const configuredRetentionDays = (value?: string) => integerSetting(value, 30, 1, 365, "RETENTION_DAYS");
const configuredAdmissionLimit = (value?: string) => integerSetting(value, 10_000, 1, 100_000, "MAX_DAILY_NEW_INSTALLS");

function looksLikeIp(value: string): boolean {
  if (ipv6.test(value)) return true;
  if (!ipv4.test(value)) return false;
  return value.split(".").every((part) => Number(part) <= 255);
}

export function parseTelemetryReport(value: unknown): TelemetryReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Telemetry report must be an object");
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !reportKeys.has(key));
  if (unexpected.length) throw new HttpError(400, "Telemetry report contains an unsupported field");
  if (typeof record.installId !== "string" || !uuidV4.test(record.installId)) throw new HttpError(400, "installId must be an opaque UUID");
  if (typeof record.releaseVersion !== "string" || !releaseVersion.test(record.releaseVersion) || record.releaseVersion.length > 40) throw new HttpError(400, "releaseVersion is invalid");
  if (record.activeKioskCount !== 0 && record.activeKioskCount !== 1) throw new HttpError(400, "activeKioskCount must be zero or one");
  if (record.errorCategory !== undefined && record.errorCategory !== "worker-internal" && record.errorCategory !== "integration-upstream") throw new HttpError(400, "errorCategory is invalid");
  let metro: string | undefined;
  if (record.metro !== undefined) {
    if (typeof record.metro !== "string") throw new HttpError(400, "metro must be text");
    metro = record.metro.trim().normalize("NFC");
    if (!metro || metro.length > 100 || controlCharacters.test(metro) || looksLikeIp(metro)) throw new HttpError(400, "metro is invalid");
  }
  return {
    installId: record.installId.toLowerCase(),
    releaseVersion: record.releaseVersion,
    activeKioskCount: record.activeKioskCount,
    ...(record.errorCategory ? { errorCategory: record.errorCategory as TelemetryReport["errorCategory"] } : {}),
    ...(metro ? { metro } : {}),
  };
}

async function readReport(request: Request): Promise<TelemetryReport> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  if (Number(request.headers.get("content-length") ?? 0) > 4096) throw new HttpError(413, "Telemetry report is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 4096) throw new HttpError(413, "Telemetry report is too large");
  try { return parseTelemetryReport(JSON.parse(text)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Telemetry report must be valid JSON"); }
}

async function readDeletionRequest(request: Request): Promise<string> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  if (Number(request.headers.get("content-length") ?? 0) > 1024) throw new HttpError(413, "Deletion request is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 1024) throw new HttpError(413, "Deletion request is too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, "Deletion request must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Deletion request must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !deletionKeys.has(key))) throw new HttpError(400, "Deletion request contains an unsupported field");
  if (typeof record.installId !== "string" || !uuidV4.test(record.installId)) throw new HttpError(400, "installId must be an opaque UUID");
  return record.installId.toLowerCase();
}

function requireDatabase(env: Env): D1Database {
  if (!env.DB) throw new HttpError(503, "Collector database is not configured");
  return env.DB;
}

export async function hashInstallId(installId: string, pepper: string): Promise<string> {
  if (pepper.length < 32) throw new HttpError(503, "INSTALL_ID_PEPPER is not configured securely");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(installId)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorized(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  const supplied = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]{32,256})$/)?.[1] ?? "";
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [actualBytes, expectedBytes] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = actualBytes.length ^ expectedBytes.length;
  for (let index = 0; index < Math.min(actualBytes.length, expectedBytes.length); index += 1) difference |= actualBytes[index] ^ expectedBytes[index];
  return difference === 0;
}

async function acceptReport(request: Request, env: Env): Promise<Response> {
  if (!env.GLOBAL_LIMITER || !env.INSTALL_LIMITER) throw new HttpError(503, "Collector rate limiting is not configured");
  if (!(await env.GLOBAL_LIMITER.limit({ key: "telemetry-report" })).success) throw new HttpError(429, "Collector is busy; try again later");
  const report = await readReport(request);
  const installHash = await hashInstallId(report.installId, env.INSTALL_ID_PEPPER ?? "");
  if (!(await env.INSTALL_LIMITER.limit({ key: installHash })).success) throw new HttpError(429, "This installation is reporting too frequently");
  const db = requireDatabase(env);
  const now = new Date().toISOString();
  const reportDay = now.slice(0, 10);
  const existing = await db.prepare("SELECT install_hash AS installHash FROM telemetry_installations WHERE install_hash = ?").bind(installHash).first<{ installHash: string }>();
  if (!existing) {
    const admissionLimit = configuredAdmissionLimit(env.MAX_DAILY_NEW_INSTALLS);
    const admitted = await db.prepare("SELECT COUNT(*) AS count FROM telemetry_installations WHERE first_seen_at >= ?").bind(`${reportDay}T00:00:00.000Z`).first<{ count: number }>();
    if (Number(admitted?.count ?? 0) >= admissionLimit) throw new HttpError(429, "Collector admission limit reached; try again tomorrow");
    await db.prepare("INSERT OR IGNORE INTO telemetry_installations (install_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?)").bind(installHash, now, now).run();
  } else {
    await db.prepare("UPDATE telemetry_installations SET last_seen_at = ? WHERE install_hash = ?").bind(now, installHash).run();
  }
  await db.prepare("INSERT INTO telemetry_reports (install_hash, report_day, release_version, active_kiosk_count, error_category, metro, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(install_hash, report_day) DO UPDATE SET release_version = excluded.release_version, active_kiosk_count = excluded.active_kiosk_count, error_category = COALESCE(excluded.error_category, telemetry_reports.error_category), metro = COALESCE(excluded.metro, telemetry_reports.metro), observed_at = excluded.observed_at")
    .bind(installHash, reportDay, report.releaseVersion, report.activeKioskCount, report.errorCategory ?? null, report.metro ?? null, now).run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function summary(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env.ADMIN_BEARER_TOKEN))) throw new HttpError(401, "Collector administrator authorization required");
  const db = requireDatabase(env);
  const days = configuredRetentionDays(env.RETENTION_DAYS);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const totals = await db.prepare("WITH recent AS (SELECT install_hash, active_kiosk_count, observed_at FROM telemetry_reports WHERE observed_at >= ?), latest AS (SELECT report.install_hash, report.active_kiosk_count FROM recent AS report JOIN (SELECT install_hash, MAX(observed_at) AS observed_at FROM recent GROUP BY install_hash) AS newest ON newest.install_hash = report.install_hash AND newest.observed_at = report.observed_at) SELECT (SELECT COUNT(*) FROM latest) AS uniqueInstallations, (SELECT COUNT(*) FROM recent) AS reports, COALESCE((SELECT SUM(active_kiosk_count) FROM latest), 0) AS activeKiosks").bind(since).first();
  const releases = await db.prepare("SELECT release_version AS releaseVersion, COUNT(DISTINCT install_hash) AS installations FROM telemetry_reports WHERE observed_at >= ? GROUP BY release_version ORDER BY installations DESC, release_version ASC").bind(since).all();
  const diagnostics = await db.prepare("SELECT error_category AS errorCategory, COUNT(*) AS reports FROM telemetry_reports WHERE observed_at >= ? AND error_category IS NOT NULL GROUP BY error_category ORDER BY error_category").bind(since).all();
  const metros = await db.prepare("SELECT metro, COUNT(DISTINCT install_hash) AS installations FROM telemetry_reports WHERE observed_at >= ? AND metro IS NOT NULL GROUP BY metro HAVING COUNT(DISTINCT install_hash) >= 5 ORDER BY installations DESC, metro ASC LIMIT 100").bind(since).all();
  return json({ retentionDays: days, totals: totals ?? { uniqueInstallations: 0, reports: 0, activeKiosks: 0 }, releases: releases.results ?? [], diagnostics: diagnostics.results ?? [], metros: metros.results ?? [] });
}

async function deleteInstallation(request: Request, env: Env): Promise<Response> {
  if (!(await authorized(request, env.ADMIN_BEARER_TOKEN))) throw new HttpError(401, "Collector administrator authorization required");
  const installId = await readDeletionRequest(request);
  const installHash = await hashInstallId(installId, env.INSTALL_ID_PEPPER ?? "");
  const db = requireDatabase(env);
  await db.batch([
    db.prepare("DELETE FROM telemetry_reports WHERE install_hash = ?").bind(installHash),
    db.prepare("DELETE FROM telemetry_installations WHERE install_hash = ?").bind(installHash),
  ]);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

export async function purgeExpired(env: Env, now = new Date()): Promise<void> {
  const db = requireDatabase(env);
  const cutoff = new Date(now.getTime() - configuredRetentionDays(env.RETENTION_DAYS) * 86_400_000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM telemetry_reports WHERE observed_at < ?").bind(cutoff),
    db.prepare("DELETE FROM telemetry_installations WHERE NOT EXISTS (SELECT 1 FROM telemetry_reports WHERE telemetry_reports.install_hash = telemetry_installations.install_hash)"),
  ]);
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health" && request.method === "GET") return json({ ok: true, service: "lancerlogin-telemetry-collector" });
  if (path === "/v1/report" && request.method === "POST") return acceptReport(request, env);
  if (path === "/v1/summary" && request.method === "GET") return summary(request, env);
  if (path === "/v1/admin/delete-installation" && request.method === "POST") return deleteInstallation(request, env);
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, error.status === 429 ? { "retry-after": "60" } : undefined);
      return json({ error: "Collector request failed" }, 500);
    }
  },
  async scheduled(controller: { scheduledTime?: number }, env: Env): Promise<void> {
    await purgeExpired(env, controller.scheduledTime ? new Date(controller.scheduledTime) : new Date());
  },
};
