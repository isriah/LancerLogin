import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

const installationId = "primary";
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8" } });
}

function date(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new HttpError(400, `Provide a valid ${label} date`);
  return value;
}

async function readBody(request: Request) {
  const text = await request.text();
  if (text.length > 4096) throw new HttpError(413, "Request body is too large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, "Request body must be valid JSON"); }
  if (!object(value)) throw new HttpError(400, "Request body must be an object");
  return value;
}

export async function attendanceMemberSettings(request: Request, db: D1Database, actorUserId: string, role: "admin" | "operator") {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/admin/attendance/members") {
    if (request.method !== "GET") throw new HttpError(405, "Use GET to list Attendance member settings");
    const result = await db.prepare(`SELECT external_id AS memberId,attendance_required_from AS attendanceRequiredFrom
      FROM members WHERE installation_id=? ORDER BY external_id`).bind(installationId).all();
    return json({ members: result.results ?? [] });
  }
  const match = pathname.match(/^\/admin\/attendance\/members\/([^/]+)$/);
  if (!match || request.method !== "PATCH") throw new HttpError(404, "Attendance member setting route not found");
  if (role !== "admin") throw new HttpError(403, "Only an Admin can change Attendance member settings");
  let memberId: string;
  try { memberId = decodeURIComponent(match[1]); } catch { throw new HttpError(400, "Member identity is invalid"); }
  if (!memberId || memberId.length > 128 || /[\s/\\\0]/.test(memberId)) throw new HttpError(400, "Member identity is invalid");
  const body = await readBody(request);
  if (Object.keys(body).length !== 2 || Object.keys(body).some((key) => !["attendanceRequiredFrom", "expected"].includes(key))) throw new HttpError(400, "Provide the participation date and its previously displayed value");
  const next = date(body.attendanceRequiredFrom, "participation start"); const expected = date(body.expected, "previous participation start");
  const current = await db.prepare("SELECT attendance_required_from AS attendanceRequiredFrom FROM members WHERE installation_id=? AND external_id=?").bind(installationId, memberId).first<{ attendanceRequiredFrom: string | null }>();
  if (!current) throw new HttpError(404, "Member not found");
  if (current.attendanceRequiredFrom === next) return json({ memberId, attendanceRequiredFrom: next });
  if (current.attendanceRequiredFrom !== expected) throw new HttpError(409, "Participation date changed; reload before retrying");
  const now = new Date().toISOString();
  const results = await db.batch([
    db.prepare("UPDATE members SET attendance_required_from=? WHERE installation_id=? AND external_id=? AND attendance_required_from IS ?").bind(next, installationId, memberId, expected),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,?,?, 'attendance.member_setting_updated','member',id,?,? FROM members WHERE installation_id=? AND external_id=? AND changes()=1`)
      .bind(crypto.randomUUID(), installationId, actorUserId, JSON.stringify({ attendanceRequiredFrom: next }), now, installationId, memberId),
  ]);
  if (results[1]?.meta?.changes !== 1) throw new HttpError(409, "Participation date changed; reload before retrying");
  return json({ memberId, attendanceRequiredFrom: next });
}
