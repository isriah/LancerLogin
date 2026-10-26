import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

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
  input: (id) => ({ sql: `EXISTS(SELECT 1 FROM attendance_events e
    JOIN meetings m ON m.installation_id=e.installation_id AND m.id=e.meeting_id
    JOIN members r ON r.installation_id=e.installation_id AND r.id=e.member_id
    JOIN organization_settings s ON s.installation_id=e.installation_id
    WHERE e.installation_id=? AND e.source IN ('kiosk','simulator') AND e.action='check_in' AND length(trim(e.kiosk_event_id))>0
    AND m.deleted_at IS NULL AND m.is_test=0 AND r.active=1 AND julianday(e.occurred_at)>=julianday(m.starts_at)
    AND unixepoch(e.occurred_at,'subsec')<=unixepoch(m.ends_at,'subsec')+s.late_scan_minutes*60)`, bindings: [id] }),
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
  const row = await db.prepare(`SELECT late_scan_minutes AS lateScanMinutes,attendance_reporting_starts_on AS attendanceReportingStartsOn,
    anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes,anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes,time_zone AS timeZone
    FROM organization_settings WHERE installation_id=?`).bind(installationId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(409, "Save organization setup before configuring Attendance");
  if (request.method === "GET") return json({ values: { lateScanMinutes: row.lateScanMinutes, attendanceReportingStartsOn: row.attendanceReportingStartsOn, anomalyLateThresholdMinutes: row.anomalyLateThresholdMinutes, anomalyEarlyThresholdMinutes: row.anomalyEarlyThresholdMinutes }, timeZone: row.timeZone });
  if (request.method !== "PUT") throw new HttpError(405, "Use GET or PUT for Attendance rules setup");
  const body = await readJson(request, 4096);
  if (!object(body.values) || !object(body.expected) || Object.keys(body).some((key) => !["values", "expected"].includes(key))) throw new HttpError(400, "Provide Attendance rules and their previously displayed values");
  const read = (value: JsonRecord) => [integer(value.lateScanMinutes, 180, "late scan limit"), date(value.attendanceReportingStartsOn, true), integer(value.anomalyLateThresholdMinutes, 180, "late anomaly threshold"), integer(value.anomalyEarlyThresholdMinutes, 180, "early anomaly threshold")] as const;
  const next = read(body.values); const expected = read(body.expected); const now = new Date().toISOString();
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
  const settings = await db.prepare("SELECT time_zone AS timeZone,late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ timeZone: string; lateScanMinutes: number }>();
  if (!settings) throw new HttpError(409, "Save organization setup before creating a meeting");
  try { if (localDay(startsAt, settings.timeZone) !== localDay(endsAt, settings.timeZone)) throw new Error(); }
  catch { throw new HttpError(400, "Meeting start and end must use the same organization date"); }
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,notes,created_by,created_at,is_test)
      SELECT ?,?,?,?,?,?,?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM meetings WHERE installation_id=? AND deleted_at IS NULL
        AND unixepoch(?,'subsec')<=unixepoch(ends_at,'subsec')+?*60 AND unixepoch(?,'subsec')+?*60>=unixepoch(starts_at,'subsec'))`)
      .bind(id, installationId, input.title.trim(), startsAt, endsAt, Number(input.required ?? true), typeof input.notes === "string" ? input.notes : null, userId, now,
        installationId, startsAt, settings.lateScanMinutes, endsAt, settings.lateScanMinutes),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at)
      SELECT ?,?,?, 'meeting.created','meeting',?,? WHERE changes()=1`).bind(crypto.randomUUID(), installationId, userId, id, now),
  ]);
  if (results[1]?.meta?.changes !== 1) throw new HttpError(409, "Meeting attendance windows overlap; choose another time and retry");
  return json({ id }, 201);
}

async function input(request: Request, db: D1Database, userId: string) {
  if (request.method === "GET") {
    const [simulator, members, meetings] = await Promise.all([
      db.prepare("SELECT name,active,online FROM simulated_kiosk_sessions WHERE installation_id=?").bind(installationId).first(),
      db.prepare("SELECT external_id AS id,trim(first_name||' '||last_name) AS label FROM members WHERE installation_id=? AND active=1 ORDER BY last_name,first_name LIMIT 100").bind(installationId).all(),
      db.prepare("SELECT id,title,starts_at AS startsAt,ends_at AS endsAt FROM meetings WHERE installation_id=? AND deleted_at IS NULL AND is_test=0 ORDER BY starts_at DESC,id LIMIT 100").bind(installationId).all(),
    ]);
    return json({ mode: "browser", fingerprintReaderVerified: false, simulator, members: members.results ?? [], meetings: meetings.results ?? [] });
  }
  if (request.method !== "POST") throw new HttpError(405, "Use GET or POST for browser Attendance setup");
  const body = await readJson(request, 4096);
  if (body.action === "start") {
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Browser simulator";
    if (name.length > 80 || Object.keys(body).some((key) => !["action", "name"].includes(key))) throw new HttpError(400, "Provide a valid browser simulator name");
    const pairingId = crypto.randomUUID(); const now = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE pairing_codes SET expires_at=? WHERE installation_id=? AND id IN (SELECT pairing_code_id FROM simulated_kiosk_sessions WHERE installation_id=?)").bind(now, installationId, installationId),
      db.prepare("INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,redeemed_at,created_by,created_at,purpose) VALUES(?,?,lower(hex(randomblob(32))),?,?,?,?,'simulator')").bind(pairingId, installationId, now, now, userId, now),
      db.prepare(`INSERT INTO simulated_kiosk_sessions(installation_id,pairing_code_id,name,active,online,last_seen_at,created_by,created_at)
        VALUES(?,?,?,1,1,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET pairing_code_id=excluded.pairing_code_id,name=excluded.name,
        active=1,online=1,last_seen_at=excluded.last_seen_at,created_by=excluded.created_by,created_at=excluded.created_at`).bind(installationId, pairingId, name, now, userId, now),
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) VALUES(?,?,?,'simulator.paired','simulated_kiosk','browser',?)").bind(crypto.randomUUID(), installationId, userId, now),
    ]);
    return json({ mode: "browser", active: true, online: true, fingerprintReaderVerified: false });
  }
  if (body.action !== "scan" || Object.keys(body).some((key) => !["action", "memberId", "meetingId", "eventId"].includes(key)) || typeof body.memberId !== "string" || typeof body.meetingId !== "string") throw new HttpError(400, "Provide a member and meeting for a server-timed browser scan");
  const now = new Date().toISOString(); const eventId = typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : `simulator-${crypto.randomUUID()}`;
  if (eventId.length > 100) throw new HttpError(400, "Attendance event identity is too long");
  const [member, selectedMeeting, settings, simulator] = await Promise.all([
    db.prepare("SELECT id,external_id AS externalId,first_name AS firstName,attendance_required_from AS attendanceRequiredFrom FROM members WHERE installation_id=? AND external_id=? AND active=1").bind(installationId, body.memberId).first<{ id: string; externalId: string; firstName: string; attendanceRequiredFrom: string | null }>(),
    db.prepare("SELECT id,title,starts_at AS startsAt,ends_at AS endsAt FROM meetings WHERE installation_id=? AND id=? AND deleted_at IS NULL AND is_test=0").bind(installationId, body.meetingId).first<{ id: string; title: string; startsAt: string; endsAt: string }>(),
    db.prepare("SELECT late_scan_minutes AS lateScanMinutes FROM organization_settings WHERE installation_id=?").bind(installationId).first<{ lateScanMinutes: number }>(),
    db.prepare("SELECT 1 AS ready FROM simulated_kiosk_sessions WHERE installation_id=? AND active=1 AND online=1").bind(installationId).first(),
  ]);
  if (!member || !selectedMeeting || !settings || !simulator) throw new HttpError(409, "Start the simulator and choose an active member and meeting");
  if (member.attendanceRequiredFrom && selectedMeeting.startsAt.slice(0, 10) < member.attendanceRequiredFrom) throw new HttpError(409, `Attendance for ${member.firstName} begins on ${member.attendanceRequiredFrom}`);
  if (Date.parse(now) < Date.parse(selectedMeeting.startsAt) || Date.parse(now) > Date.parse(selectedMeeting.endsAt) + settings.lateScanMinutes * 60_000) throw new HttpError(409, "Choose a meeting whose attendance window is open now");
  const result = await db.prepare(`INSERT OR IGNORE INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,kiosk_event_id,created_by,action)
    SELECT ?,?,?,?,?,?,?,?,'check_in' WHERE EXISTS(SELECT 1 FROM simulated_kiosk_sessions WHERE installation_id=? AND active=1 AND online=1)`)
    .bind(crypto.randomUUID(), installationId, member.id, selectedMeeting.id, "simulator", now, eventId, userId, installationId).run();
  return json({ accepted: result.meta?.changes === 1, duplicate: result.meta?.changes !== 1, eventId, action: "check_in", meeting: { id: selectedMeeting.id, title: selectedMeeting.title }, member: { id: member.id, externalId: member.externalId } }, result.meta?.changes === 1 ? 202 : 200);
}

export async function attendanceSetupRoute(request: Request, db: D1Database, userId: string) {
  const path = new URL(request.url).pathname;
  if (path === "/module-setup/attendance/rules") return rules(request, db, userId);
  if (path === "/module-setup/attendance/meeting") return meeting(request, db, userId);
  if (path === "/module-setup/attendance/input") return input(request, db, userId);
  throw new HttpError(404, "Attendance setup route not found");
}
