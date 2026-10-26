import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value);
type ScanEvidence = { eventId: string; memberId: string; occurredAt: string; reasonCode: string; httpStatus: number | null; meetingId?: string; pairingId?: string; clock?: Record<string, unknown> };
type Upload = { evidence: ScanEvidence; reviewed: boolean };

export function validateScanReviewUpload(input: unknown): Upload[] {
  if (!object(input) || Object.keys(input).some(key => key !== "records") || !Array.isArray(input.records) || !input.records.length || input.records.length > 50) throw new HttpError(400, "Provide between 1 and 50 retained scan records");
  const seen = new Set<string>();
  return input.records.map(value => {
    if (!object(value) || Object.keys(value).some(key => !["eventId", "memberId", "occurredAt", "reasonCode", "httpStatus", "meetingId", "pairingId", "clock", "reviewStatus", "reviewedAt"].includes(key))
      || !text(value.eventId) || seen.has(value.eventId) || !text(value.memberId) || !text(value.occurredAt, 64) || !Number.isFinite(Date.parse(value.occurredAt))
      || typeof value.reasonCode !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(value.reasonCode)
      || value.httpStatus !== null && value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || Number(value.httpStatus) < 100 || Number(value.httpStatus) > 599)
      || !["open", "reviewed"].includes(String(value.reviewStatus))
      || value.meetingId !== undefined && !text(value.meetingId) || value.pairingId !== undefined && !text(value.pairingId)
      || value.reviewedAt !== undefined && (!text(value.reviewedAt, 64) || !Number.isFinite(Date.parse(value.reviewedAt)))) throw new HttpError(400, "Invalid retained scan record");
    seen.add(value.eventId);
    let clock: Record<string, unknown> | undefined;
    if (value.clock !== undefined) {
      const source = value.clock;
      if (!object(source) || Object.keys(source).some(key => !["version", "bootId", "elapsedMs", "observedAt", "verified", "source"].includes(key)) || source.version !== 1 || typeof source.verified !== "boolean"
        || source.bootId !== undefined && !text(source.bootId) || source.elapsedMs !== undefined && (!Number.isSafeInteger(source.elapsedMs) || Number(source.elapsedMs) < 0)
        || source.observedAt !== undefined && (!text(source.observedAt, 64) || !Number.isFinite(Date.parse(source.observedAt)))
        || source.source !== undefined && !["network", "operator"].includes(String(source.source))) throw new HttpError(400, "Invalid scan clock evidence");
      clock = Object.fromEntries(["version", "bootId", "elapsedMs", "observedAt", "verified", "source"].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
    }
    return { evidence: { eventId: value.eventId, memberId: value.memberId, occurredAt: value.occurredAt, reasonCode: value.reasonCode, httpStatus: value.httpStatus as number ?? null,
      ...(value.meetingId ? { meetingId: String(value.meetingId) } : {}), ...(value.pairingId ? { pairingId: String(value.pairingId) } : {}), ...(clock ? { clock } : {}) }, reviewed: value.reviewStatus === "reviewed" };
  });
}

export async function syncKioskScanReviews(db: D1Database, kiosk: { id: string; pairingId: string | null; tokenHash: string }, input: unknown) {
  const records = validateScanReviewUpload(input), now = new Date().toISOString();
  const selected = JSON.stringify(records.map(record => ({ eventId: record.evidence.eventId, evidence: JSON.stringify(record.evidence), reviewed: record.reviewed, auditId: crypto.randomUUID() })));
  // A fixed number of statements keeps a full batch within request query budgets.
  const statements = [
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM kiosks WHERE installation_id='primary' AND id=? AND active=1 AND pairing_code_id IS ? AND token_hash=?) THEN 1 ELSE json_extract('{}','scan-review-authority') END`).bind(kiosk.id, kiosk.pairingId, kiosk.tokenHash),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM kiosk_scan_reviews r JOIN json_each(?) s ON r.event_id=json_extract(s.value,'$.eventId') WHERE r.installation_id='primary' AND r.kiosk_id=? AND r.record_json<>json_extract(s.value,'$.evidence')) THEN json_extract('{}','scan-review-conflict') ELSE 1 END`).bind(selected, kiosk.id),
    db.prepare(`INSERT INTO kiosk_scan_reviews(installation_id,kiosk_id,event_id,record_json,received_at)
      SELECT 'primary',?,json_extract(value,'$.eventId'),json_extract(value,'$.evidence'),? FROM json_each(?) WHERE 1
      ON CONFLICT(installation_id,kiosk_id,event_id) DO NOTHING`).bind(kiosk.id, now, selected),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT json_extract(s.value,'$.auditId'),'primary',NULL,'kiosk.scan_reviewed_locally','kiosk',?,json_object('eventId',r.event_id),?
      FROM kiosk_scan_reviews r JOIN json_each(?) s ON r.event_id=json_extract(s.value,'$.eventId')
      WHERE r.installation_id='primary' AND r.kiosk_id=? AND r.review_status='open' AND json_extract(s.value,'$.reviewed')=1`).bind(kiosk.id, now, selected, kiosk.id),
    db.prepare(`UPDATE kiosk_scan_reviews SET review_status='reviewed',reviewed_at=?,review_note='Reviewed in kiosk maintenance'
      WHERE installation_id='primary' AND kiosk_id=? AND review_status='open' AND EXISTS(SELECT 1 FROM json_each(?) s JOIN audit_log a ON a.id=json_extract(s.value,'$.auditId') WHERE event_id=json_extract(s.value,'$.eventId'))`).bind(now, kiosk.id, selected),
    db.prepare(`SELECT event_id AS eventId,review_status AS reviewStatus FROM kiosk_scan_reviews WHERE installation_id='primary' AND kiosk_id=? AND event_id IN (SELECT json_extract(value,'$.eventId') FROM json_each(?))`).bind(kiosk.id, selected),
  ];
  try {
    const result = await db.batch(statements);
    return { reviews: result.at(-1)?.results ?? [] };
  } catch (error) {
    if (error instanceof Error && error.message.includes("scan-review-authority")) throw new HttpError(403, "Kiosk pairing changed before scan review synchronization");
    if (error instanceof Error && error.message.includes("scan-review-conflict")) throw new HttpError(409, "Retained scan evidence conflicts with an earlier upload");
    throw error;
  }
}

export async function listKioskScanReviews(db: D1Database, status: string, offset: number) {
  if (!["open", "reviewed"].includes(status) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new HttpError(400, "Invalid scan review page");
  const rows = (await db.prepare(`SELECT r.kiosk_id AS kioskId,k.name AS kioskName,r.record_json AS evidence,r.received_at AS receivedAt,r.review_status AS reviewStatus,r.reviewed_at AS reviewedAt,r.review_note AS reviewNote
    FROM kiosk_scan_reviews r JOIN kiosks k ON k.installation_id=r.installation_id AND k.id=r.kiosk_id
    WHERE r.installation_id='primary' AND r.review_status=? ORDER BY r.received_at,r.kiosk_id,r.event_id LIMIT 51 OFFSET ?`).bind(status, offset).all<{ kioskId: string; kioskName: string; evidence: string; receivedAt: string; reviewStatus: string; reviewedAt: string | null; reviewNote: string | null }>()).results ?? [];
  return { records: rows.slice(0, 50).map(({ evidence, ...row }) => ({ ...JSON.parse(evidence), ...row })), hasMore: rows.length > 50 };
}

export async function markKioskScanReviewed(db: D1Database, actor: string, kioskId: string, eventId: string, input: unknown) {
  if (!text(kioskId) || !text(eventId) || !object(input) || Object.keys(input).some(key => key !== "note") || typeof input.note !== "string" || !input.note.trim() || input.note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.note)) throw new HttpError(400, "A review note of 1 to 500 characters is required");
  const now = new Date().toISOString(), auditId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND active=1 AND role='admin') THEN 1 ELSE json_extract('{}','scan-review-admin') END`).bind(actor),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,'primary',?,'kiosk.scan_reviewed','kiosk',?,json_object('eventId',?,'note',?),? WHERE EXISTS(SELECT 1 FROM kiosk_scan_reviews WHERE installation_id='primary' AND kiosk_id=? AND event_id=? AND review_status='open')`).bind(auditId, actor, kioskId, eventId, input.note.trim(), now, kioskId, eventId),
    db.prepare(`UPDATE kiosk_scan_reviews SET review_status='reviewed',reviewed_at=?,review_note=? WHERE installation_id='primary' AND kiosk_id=? AND event_id=? AND review_status='open' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(now, input.note.trim(), kioskId, eventId, auditId),
    db.prepare(`SELECT review_status AS status FROM kiosk_scan_reviews WHERE installation_id='primary' AND kiosk_id=? AND event_id=?`).bind(kioskId, eventId),
  ]).catch(error => { if (error instanceof Error && error.message.includes("scan-review-admin")) throw new HttpError(403, "Administrator authorization changed"); throw error; });
  if (!results.at(-1)?.results?.length) throw new HttpError(404, "Retained scan not found");
  return { reviewed: true };
}
