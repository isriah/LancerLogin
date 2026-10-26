import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

type Session = { id: string; pairingId: string; expiresAt: string; state: "waiting_member" | "ready" | "cancelled"; progress: string; message: string | null; member?: { rosterId: string; memberId: string; firstName: string; lastName: string } };
type Row = Omit<Session, "member"> & { rosterId: string | null; memberId: string | null; firstName: string | null; lastName: string | null; memberActive: number | null };
const terminal = new Set(["enroll_success", "enroll_failure", "cancelled", "expired"]);
const steps = ["waiting_member", "awaiting_confirmation", "enroll_wait_first", "enroll_remove", "enroll_wait_second", "enroll_success"];

// Every delivery rechecks the pairing, method, creator and selected roster identity.
// The Attendance route/database boundary additionally checks current module authority.
export async function readKioskEnrollment(db: D1Database, kioskId: string, includeExpired = false): Promise<Session | null> {
  const row = await db.prepare(`SELECT s.id,s.pairing_id AS pairingId,s.expires_at AS expiresAt,s.state,s.progress,s.message,
    m.id AS rosterId,m.external_id AS memberId,m.first_name AS firstName,m.last_name AS lastName,m.active AS memberActive
    FROM kiosk_enrollment_sessions s JOIN kiosks k ON k.id=s.kiosk_id AND k.installation_id=s.installation_id
    JOIN users u ON u.id=s.created_by AND u.installation_id=s.installation_id
    LEFT JOIN members m ON m.id=s.member_id AND m.installation_id=s.installation_id
    WHERE s.installation_id='primary' AND s.kiosk_id=? AND k.active=1 AND k.pairing_bound=1
      AND k.pairing_code_id=s.pairing_id AND k.configured_authentication_method='fingerprint' AND u.active=1 AND u.role='admin'`).bind(kioskId).first<Row>();
  if (!row) return null;
  if (row.rosterId && !row.memberActive) return null;
  const expired = Date.parse(row.expiresAt) <= Date.now();
  if (expired && !includeExpired) return null;
  return { id: row.id, pairingId: row.pairingId, expiresAt: row.expiresAt, state: expired ? "cancelled" : row.state,
    progress: expired && !terminal.has(row.progress) ? "expired" : row.progress, message: row.message,
    ...(row.rosterId ? { member: { rosterId: row.rosterId, memberId: row.memberId!, firstName: row.firstName!, lastName: row.lastName! } } : {}) };
}

export async function startKioskEnrollment(db: D1Database, kioskId: string, userId: string): Promise<Session> {
  const kiosk = await db.prepare(`SELECT pairing_code_id AS pairingId,last_seen_at AS lastSeenAt,reader_online AS readerOnline,
    configured_authentication_method AS method,authentication_method AS reportedMethod FROM kiosks
    WHERE installation_id='primary' AND id=? AND active=1 AND pairing_bound=1`).bind(kioskId).first<{ pairingId: string; lastSeenAt: string; readerOnline: number; method: string; reportedMethod: string }>();
  if (!kiosk) throw new HttpError(404, "Active paired kiosk not found");
  if (kiosk.method !== "fingerprint" || kiosk.reportedMethod !== "fingerprint" || !kiosk.readerOnline || !(Date.now() - Date.parse(kiosk.lastSeenAt) < 90_000)) throw new HttpError(409, "Enrollment requires an online kiosk with its fingerprint reader ready");
  const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(), id = crypto.randomUUID();
  await db.prepare(`INSERT INTO kiosk_enrollment_sessions(id,installation_id,kiosk_id,pairing_id,created_by,created_at,expires_at,state,progress,updated_at)
    VALUES (?,'primary',?,?,?,?,?,'waiting_member','waiting_member',?)
    ON CONFLICT(installation_id,kiosk_id) DO UPDATE SET id=excluded.id,pairing_id=excluded.pairing_id,created_by=excluded.created_by,
      created_at=excluded.created_at,expires_at=excluded.expires_at,state=excluded.state,progress=excluded.progress,member_id=NULL,message=NULL,updated_at=excluded.updated_at
    WHERE kiosk_enrollment_sessions.expires_at<=? OR kiosk_enrollment_sessions.progress IN ('enroll_success','enroll_failure','cancelled','expired')
      OR kiosk_enrollment_sessions.pairing_id<>excluded.pairing_id
      OR NOT EXISTS(SELECT 1 FROM users u WHERE u.installation_id=kiosk_enrollment_sessions.installation_id AND u.id=kiosk_enrollment_sessions.created_by AND u.active=1 AND u.role='admin')
      OR (kiosk_enrollment_sessions.member_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM members m WHERE m.installation_id=kiosk_enrollment_sessions.installation_id AND m.id=kiosk_enrollment_sessions.member_id AND m.active=1))`)
    .bind(id, kioskId, kiosk.pairingId, userId, now, expiresAt, now, now).run();
  const session = await readKioskEnrollment(db, kioskId);
  if (session?.id !== id) throw new HttpError(409, "An enrollment session is already active on this kiosk");
  return session;
}

export async function selectEnrollmentMember(db: D1Database, kioskId: string, sessionId: string, rosterId: unknown): Promise<Session> {
  if (typeof rosterId !== "string" || !rosterId || rosterId.length > 128) throw new HttpError(400, "Choose an active roster member");
  const session = await readKioskEnrollment(db, kioskId);
  if (!session || session.id !== sessionId || session.state !== "waiting_member") throw new HttpError(409, "Enrollment is no longer waiting for a member");
  const result = await db.prepare(`UPDATE kiosk_enrollment_sessions SET member_id=?,state='ready',progress='awaiting_confirmation',updated_at=?
    WHERE installation_id='primary' AND kiosk_id=? AND id=? AND state='waiting_member' AND expires_at>?
    AND EXISTS(SELECT 1 FROM members WHERE installation_id='primary' AND id=? AND active=1)`)
    .bind(rosterId, new Date().toISOString(), kioskId, sessionId, new Date().toISOString(), rosterId).run();
  if (!result.meta?.changes) throw new HttpError(409, "Member is inactive or enrollment has changed. Refresh and try again.");
  return (await readKioskEnrollment(db, kioskId))!;
}

export async function cancelKioskEnrollment(db: D1Database, kioskId: string, sessionId: string): Promise<void> {
  await db.prepare(`UPDATE kiosk_enrollment_sessions SET state='cancelled',progress='cancelled',updated_at=?
    WHERE installation_id='primary' AND kiosk_id=? AND id=? AND progress NOT IN ('enroll_success','enroll_failure','cancelled','expired')`)
    .bind(new Date().toISOString(), kioskId, sessionId).run();
}

export async function progressKioskEnrollment(db: D1Database, kioskId: string, sessionId: string, status: unknown): Promise<Session> {
  if (typeof status !== "string" || ![...steps, "enroll_failure", "cancelled", "expired"].includes(status)) throw new HttpError(400, "Unsupported enrollment progress");
  const session = await readKioskEnrollment(db, kioskId);
  if (!session || session.id !== sessionId) throw new HttpError(409, "Enrollment session expired or is no longer authorized");
  if (session.progress === status) return session;
  if (session.state === "cancelled" || terminal.has(session.progress)) throw new HttpError(409, "Enrollment has already ended");
  if (!terminal.has(status) && steps.indexOf(status) !== steps.indexOf(session.progress) + 1 || status === "enroll_success" && session.progress !== "enroll_wait_second") throw new HttpError(409, "Enrollment progress is out of order");
  if (status !== "cancelled" && status !== "expired" && status !== "enroll_failure" && !session.member) throw new HttpError(409, "Choose a member before scanning");
  const result = await db.prepare(`UPDATE kiosk_enrollment_sessions SET progress=?,state=?,updated_at=?
    WHERE installation_id='primary' AND kiosk_id=? AND id=? AND progress=? AND expires_at>?`)
    .bind(status, ["cancelled", "expired", "enroll_failure"].includes(status) ? "cancelled" : session.state, new Date().toISOString(), kioskId, sessionId, session.progress, new Date().toISOString()).run();
  if (!result.meta?.changes) throw new HttpError(409, "Enrollment changed before progress was recorded");
  return (await readKioskEnrollment(db, kioskId))!;
}
