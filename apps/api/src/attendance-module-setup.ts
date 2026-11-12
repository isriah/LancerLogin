import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { assertAllowanceChangeKeepsMeetingsApart, attendanceAllowances } from "./attendance-allowances.ts";

type JsonRecord = Record<string, unknown>;
type SetupPredicate = { sql: string; bindings: readonly unknown[] };
const installationId = "primary";
const object = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const attendanceSetupPredicates: Readonly<Record<string, (installationId: string) => SetupPredicate>> = Object.freeze({
  rules: (id) => ({ sql: `EXISTS(SELECT 1 FROM organization_settings WHERE installation_id=?
    AND typeof(late_scan_minutes)='integer' AND late_scan_minutes BETWEEN 0 AND 180
    AND (attendance_reporting_starts_on IS NULL OR (length(attendance_reporting_starts_on)=10 AND attendance_reporting_starts_on=date(attendance_reporting_starts_on)))
    AND typeof(anomaly_late_threshold_minutes)='integer' AND anomaly_late_threshold_minutes BETWEEN 0 AND 180
    AND typeof(anomaly_early_threshold_minutes)='integer' AND anomaly_early_threshold_minutes BETWEEN 0 AND 180)`, bindings: [id] }),
  meeting: (id) => ({ sql: `EXISTS(SELECT 1 FROM meetings WHERE installation_id=? AND deleted_at IS NULL AND is_test=0
    AND length(trim(title))>0 AND julianday(starts_at) IS NOT NULL AND julianday(ends_at)>julianday(starts_at))`, bindings: [id] }),
  // Verified attendance input: an active paired kiosk, Pi or web, that has checked in at least once.
  input: (id) => ({ sql: "EXISTS(SELECT 1 FROM kiosks WHERE installation_id=? AND active=1 AND last_seen_at IS NOT NULL)", bindings: [id] }),
  calendar: (id) => ({ sql: "EXISTS(SELECT 1 FROM google_calendar_authorizations WHERE installation_id=? AND verified_at IS NOT NULL)", bindings: [id] }),
  discord: (id) => ({ sql: "EXISTS(SELECT 1 FROM encrypted_integrations WHERE installation_id=? AND provider='discord' AND verified_at IS NOT NULL)", bindings: [id] }),
});

export async function attendanceSetupStepValid(db: D1Database, stepId: string) {
  const predicate = attendanceSetupPredicates[stepId];
  if (!predicate) throw new HttpError(500, "Attendance setup binding is unavailable");
  const value = predicate(installationId);
  return Boolean(await db.prepare(`SELECT 1 AS valid WHERE ${value.sql}`).bind(...value.bindings).first());
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function readJson(request: Request, maximum = 8192): Promise<JsonRecord> {
  const text = await request.text();
  if (text.length > maximum) throw new HttpError(413, "Request body is too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, "Request body must be valid JSON"); }
  if (!object(value)) throw new HttpError(400, "Request body must be an object");
  return value;
}

function integer(value: unknown, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) throw new HttpError(400, `Provide a valid ${label}`);
  return Number(value);
}

function date(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new HttpError(400, "Provide a valid reporting date");
  return value;
}

function localDay(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function rules(request: Request, db: D1Database, userId: string) {
  const row = await db.prepare(`SELECT late_scan_minutes AS lateScanMinutes,early_scan_minutes AS earlyScanMinutes,attendance_reporting_starts_on AS attendanceReportingStartsOn,
    anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes,anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes,time_zone AS timeZone
    FROM organization_settings WHERE installation_id=?`).bind(installationId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(409, "Save organization setup before configuring Attendance");
  if (request.method === "GET") return json({ values: { lateScanMinutes: row.lateScanMinutes, attendanceReportingStartsOn: row.attendanceReportingStartsOn, anomalyLateThresholdMinutes: row.anomalyLateThresholdMinutes, anomalyEarlyThresholdMinutes: row.anomalyEarlyThresholdMinutes }, timeZone: row.timeZone });
  if (request.method !== "PUT") throw new HttpError(405, "Use GET or PUT for Attendance rules setup");
  const body = await readJson(request, 4096);
  if (!object(body.values) || !object(body.expected) || Object.keys(body).some((key) => !["values", "expected"].includes(key))) throw new HttpError(400, "Provide Attendance rules and their previously displayed values");
  const read = (value: JsonRecord) => [integer(value.lateScanMinutes, 180, "late scan limit"), date(value.attendanceReportingStartsOn, true), integer(value.anomalyLateThresholdMinutes, 180, "late anomaly threshold"), integer(value.anomalyEarlyThresholdMinutes, 180, "early anomaly threshold")] as const;
  const next = read(body.values); const expected = read(body.expected); const now = new Date().toISOString();
  // A longer late scan window must not make meetings that have not closed overlap (the early arrival allowance is kept).
  const current = attendanceAllowances(row as { lateScanMinutes?: number; earlyScanMinutes?: number });
  await assertAllowanceChangeKeepsMeetingsApart(db, current, { ...current, lateScanMinutes: next[0] });
  const results = await db.batch([
    db.prepare(`UPDATE organization_settings SET late_scan_minutes=?,attendance_reporting_starts_on=?,anomaly_late_threshold_minutes=?,anomaly_early_threshold_minutes=?
      WHERE installation_id=? AND late_scan_minutes IS ? AND attendance_reporting_starts_on IS ? AND anomaly_late_threshold_minutes IS ? AND anomaly_early_threshold_minutes IS ?`)
      .bind(...next, installationId, ...expected),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,created_at)
      SELECT ?,?,?, 'attendance.rules_updated','attendance_rules',? WHERE changes()=1`).bind(crypto.randomUUID(), installationId, userId, now),
  ]);
  if (results[1]?.meta?.changes !== 1) throw new HttpError(409, "Attendance rules changed; reload before retrying");
  return json({ values: body.values });
}

function instant(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, "Provide valid meeting start and end times");
  return new Date(value).toISOString();
}

async function meeting(request: Request, db: D1Database, userId: string) {
  if (request.method === "GET") {
    const result = await db.prepare("SELECT id,title,starts_at AS startsAt,ends_at AS endsAt,required FROM meetings WHERE installation_id=? AND deleted_at IS NULL AND is_test=0 ORDER BY starts_at DESC,id LIMIT 100").bind(installationId).all();
    const settings = await db.prepare("SELECT time_zone AS timeZone FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string }>();
    if (!settings) throw new HttpError(409, "Save organization setup before creating a meeting");
    return json({ meetings: result.results ?? [], timeZone: settings.timeZone });
  }
  if (request.method !== "POST") throw new HttpError(405, "Use GET or POST for first-meeting setup");
  const input = await readJson(request);
  if (Object.keys(input).some((key) => !["title", "startsAt", "endsAt", "required", "notes"].includes(key)) || typeof input.title !== "string" || !input.title.trim() || input.title.length > 120 || input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 2000) || input.required !== undefined && typeof input.required !== "boolean") throw new HttpError(400, "Provide a title, meeting times, and optional notes");
  const startsAt = instant(input.startsAt); const endsAt = instant(input.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new HttpError(400, "Meeting end must follow its start");
  const settings = await db.prepare("SELECT time_zone AS timeZone,late_scan_minutes AS lateScanMinutes,early_scan_minutes AS earlyScanMinutes FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string; lateScanMinutes: number; earlyScanMinutes: number }>();
  if (!settings) throw new HttpError(409, "Save organization setup before creating a meeting");
  try { if (localDay(startsAt, settings.timeZone) !== localDay(endsAt, settings.timeZone)) throw new Error(); }
  catch { throw new HttpError(400, "Meeting start and end must use the same organization date"); }
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,notes,created_by,created_at,is_test)
      SELECT ?,?,?,?,?,?,?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM meetings WHERE installation_id=? AND deleted_at IS NULL
        AND unixepoch(?,'subsec')-?*60<=unixepoch(ends_at,'subsec')+?*60 AND unixepoch(?,'subsec')+?*60>=unixepoch(starts_at,'subsec')-?*60)`)
      .bind(id, installationId, input.title.trim(), startsAt, endsAt, Number(input.required ?? true), typeof input.notes === "string" ? input.notes : null, userId, now,
        installationId, startsAt, settings.earlyScanMinutes ?? 15, settings.lateScanMinutes, endsAt, settings.lateScanMinutes, settings.earlyScanMinutes ?? 15),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at)
      SELECT ?,?,?, 'meeting.created','meeting',?,? WHERE changes()=1`).bind(crypto.randomUUID(), installationId, userId, id, now),
  ]);
  if (results[1]?.meta?.changes !== 1) throw new HttpError(409, "Meeting attendance windows overlap; choose another time and retry");
  return json({ id }, 201);
}

// The Verified attendance input card lists the active paired kiosks and whether each has checked in. Kiosks pair from
// Add kiosk (POST /admin/pairing-codes), which Attendance setup allows before setup is finished.
async function input(request: Request, db: D1Database) {
  if (request.method !== "GET") throw new HttpError(405, "Use GET for Attendance input setup");
  const kiosks = await db.prepare("SELECT id,name,kind,last_seen_at AS lastSeenAt FROM kiosks WHERE installation_id=? AND active=1 ORDER BY created_at,id LIMIT 100").bind(installationId).all<{ id: string; name: string; kind: string; lastSeenAt: string | null }>();
  return json({ kiosks: (kiosks.results ?? []).map((kiosk) => ({ ...kiosk, kind: kiosk.kind === "web" ? "web" : "pi" })) });
}

export async function attendanceSetupRoute(request: Request, db: D1Database, userId: string) {
  const path = new URL(request.url).pathname;
  if (path === "/module-setup/attendance/rules") return rules(request, db, userId);
  if (path === "/module-setup/attendance/meeting") return meeting(request, db, userId);
  if (path === "/module-setup/attendance/input") return input(request, db);
  throw new HttpError(404, "Attendance setup route not found");
}
