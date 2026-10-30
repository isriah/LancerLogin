import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { fingerprintMinimumScore } from "./fingerprint-match.ts";

// One person cannot scan on two kiosks seconds apart. When a kiosk scan matches a member whose accepted scan on a
// different kiosk is this close to it, the reader most likely matched someone else's finger to that member, so the
// scan is refused and the kiosk asks for a rescan. Compared by occurred_at, so a scan uploaded late from a kiosk's
// offline queue is judged by when it happened, against accepted scans before or after it.
export const impossibleScanWindowSeconds = 30;
const acceptedRetentionMs = 31 * 24 * 60 * 60_000;
const wrongMatchRetentionMs = 90 * 24 * 60 * 60_000;
const validScore = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 65_535;

type Conflict = { eventId: string; kioskId: string; occurredAt: string; matchScore: number | null };

/** The accepted scan on another kiosk that makes this one physically impossible, if any. */
export async function findImpossibleScan(db: D1Database, kioskId: string, memberId: string, occurredAt: string) {
  return db.prepare(`SELECT a.kiosk_event_id AS eventId,a.kiosk_id AS kioskId,a.occurred_at AS occurredAt,s.match_score AS matchScore
    FROM kiosk_accepted_scans a LEFT JOIN kiosk_scan_matches s ON s.installation_id=a.installation_id AND s.kiosk_event_id=a.kiosk_event_id
    WHERE a.installation_id='primary' AND a.member_id=? AND a.kiosk_id<>? AND abs(julianday(a.occurred_at)-julianday(?))*86400.0<?
    ORDER BY abs(julianday(a.occurred_at)-julianday(?)) LIMIT 1`)
    // Before migration 0088 there is nothing to compare with, so the scan is recorded as before.
    .bind(memberId, kioskId, occurredAt, impossibleScanWindowSeconds, occurredAt).first<Conflict>().catch(() => null);
}

/** Records the refusal for the Possible wrong matches panel. Best effort: diagnostics never change the kiosk's answer. */
export async function recordPossibleWrongMatch(db: D1Database, scan: { eventId: string; kioskId: string; memberId: string; occurredAt: string; matchScore: unknown }, conflict: Conflict) {
  const now = new Date();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO kiosk_possible_wrong_matches(installation_id,kiosk_event_id,kiosk_id,member_id,occurred_at,match_score,other_kiosk_event_id,other_kiosk_id,other_occurred_at,other_match_score,recorded_at)
      VALUES ('primary',?,?,?,?,?,?,?,?,?,?)`).bind(scan.eventId, scan.kioskId, scan.memberId, scan.occurredAt, validScore(scan.matchScore) ? scan.matchScore : null,
      conflict.eventId, conflict.kioskId, conflict.occurredAt, validScore(conflict.matchScore) ? conflict.matchScore : null, now.toISOString()),
    db.prepare("DELETE FROM kiosk_possible_wrong_matches WHERE installation_id='primary' AND recorded_at<?").bind(new Date(now.getTime() - wrongMatchRetentionMs).toISOString()),
  ]).catch(() => undefined);
}

/** Statements that remember which kiosk recorded an accepted scan. Run in the same batch as the attendance insert. */
export function acceptedScanStatements(db: D1Database, scan: { eventId: string; kioskId: string; memberId: string; occurredAt: string }) {
  const now = new Date();
  return [
    db.prepare(`INSERT OR IGNORE INTO kiosk_accepted_scans(installation_id,kiosk_event_id,kiosk_id,member_id,occurred_at,recorded_at)
      SELECT 'primary',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM attendance_events WHERE installation_id='primary' AND kiosk_event_id=? AND member_id=?)`)
      .bind(scan.eventId, scan.kioskId, scan.memberId, scan.occurredAt, now.toISOString(), scan.eventId, scan.memberId),
    db.prepare("DELETE FROM kiosk_accepted_scans WHERE installation_id='primary' AND recorded_at<?").bind(new Date(now.getTime() - acceptedRetentionMs).toISOString()),
  ];
}

type WrongMatchRow = { eventId: string; rosterId: string; memberId: string | null; firstName: string | null; lastName: string | null; kioskId: string; kioskName: string | null; occurredAt: string; matchScore: number | null;
  otherEventId: string; otherKioskId: string; otherKioskName: string | null; otherOccurredAt: string; otherMatchScore: number | null; recordedAt: string };
/** The most recent refused scans, newest first, with both kiosks' names and scores. */
export async function listPossibleWrongMatches(db: D1Database) {
  const rows = await db.prepare(`SELECT w.kiosk_event_id AS eventId,w.member_id AS rosterId,m.external_id AS memberId,m.first_name AS firstName,m.last_name AS lastName,
      w.kiosk_id AS kioskId,k.name AS kioskName,w.occurred_at AS occurredAt,w.match_score AS matchScore,
      w.other_kiosk_event_id AS otherEventId,w.other_kiosk_id AS otherKioskId,o.name AS otherKioskName,w.other_occurred_at AS otherOccurredAt,w.other_match_score AS otherMatchScore,w.recorded_at AS recordedAt
    FROM kiosk_possible_wrong_matches w
    LEFT JOIN members m ON m.installation_id=w.installation_id AND m.id=w.member_id
    LEFT JOIN kiosks k ON k.installation_id=w.installation_id AND k.id=w.kiosk_id
    LEFT JOIN kiosks o ON o.installation_id=w.installation_id AND o.id=w.other_kiosk_id
    WHERE w.installation_id='primary' ORDER BY w.recorded_at DESC,w.kiosk_event_id LIMIT 100`).all<WrongMatchRow>();
  return {
    windowSeconds: impossibleScanWindowSeconds,
    matches: (rows.results ?? []).map(row => ({
      eventId: row.eventId, recordedAt: row.recordedAt,
      member: { id: row.rosterId, memberId: row.memberId, displayName: row.firstName === null ? null : `${row.firstName} ${row.lastName ?? ""}`.trim() },
      scan: { kioskId: row.kioskId, kioskName: row.kioskName, occurredAt: row.occurredAt, matchScore: row.matchScore },
      acceptedScan: { eventId: row.otherEventId, kioskId: row.otherKioskId, kioskName: row.otherKioskName, occurredAt: row.otherOccurredAt, matchScore: row.otherMatchScore },
    })),
  };
}

// Re-enrollment suggestions. A member whose recent accepted scans match weakly is close to being asked to rescan, or
// to being matched to someone else, so a mentor should enroll their fingerprint again.
export const reenrollScanCount = 5;
const reenrollMargin = 20;
const reenrollDefaultScore = 70;

/** The score below which a member's median suggests re-enrollment. Also the kiosk's weak-reading threshold, which
 * kiosk-poll.ts computes the same way in SQL as `fingerprintReenrollScore`. */
export function reenrollThreshold(minimumScore: number) {
  return minimumScore > 0 ? minimumScore + reenrollMargin : reenrollDefaultScore;
}
export async function fingerprintReenrollScore(db: D1Database) { return reenrollThreshold(await fingerprintMinimumScore(db)); }

/**
 * Members whose median score across their last five scored, accepted scans is below the threshold, in one query.
 * Only scans after the member's latest re-enrollment (dashboard enrollment or a cloud-stored template) and after an
 * Admin's latest dismissal count, so both start the history over and five new scans are needed to flag again.
 */
export async function readReenrollSuggestions(db: D1Database) {
  const threshold = await fingerprintReenrollScore(db);
  const rows = await db.prepare(`WITH since AS (
      SELECT m.id AS memberId,MAX(COALESCE(julianday(r.reenrolled_at),0),COALESCE(julianday(r.dismissed_at),0),COALESCE(v.createdAt/86400000.0+2440587.5,0)) AS since
      FROM members m
      LEFT JOIN kiosk_fingerprint_reenrollment r ON r.installation_id=m.installation_id AND r.member_id=m.id
      LEFT JOIN (SELECT member_id,MAX(created_at) AS createdAt FROM kiosk_fingerprint_vault_templates WHERE installation_id='primary' GROUP BY member_id) v ON v.member_id=m.id
      WHERE m.installation_id='primary' AND m.active=1
    ), scored AS (
      SELECT e.member_id AS memberId,s.match_score AS score,e.occurred_at AS occurredAt,
        ROW_NUMBER() OVER (PARTITION BY e.member_id ORDER BY e.occurred_at DESC,e.id DESC) AS position
      FROM kiosk_scan_matches s
      JOIN attendance_events e ON e.installation_id=s.installation_id AND e.kiosk_event_id=s.kiosk_event_id
      JOIN since ON since.memberId=e.member_id
      WHERE s.installation_id='primary' AND julianday(e.occurred_at)>since.since
    ), recent AS (
      SELECT memberId,score,occurredAt,ROW_NUMBER() OVER (PARTITION BY memberId ORDER BY score) AS rank FROM scored WHERE position<=?
    )
    SELECT r.memberId AS rosterId,m.external_id AS memberId,m.first_name AS firstName,m.last_name AS lastName,
      MAX(CASE WHEN r.rank=? THEN r.score END) AS medianScore,MIN(r.score) AS lowestScore,MAX(r.occurredAt) AS lastScanAt
    FROM recent r JOIN members m ON m.installation_id='primary' AND m.id=r.memberId
    GROUP BY r.memberId HAVING COUNT(*)=? AND MAX(CASE WHEN r.rank=? THEN r.score END)<?
    ORDER BY medianScore,m.last_name,m.first_name`)
    .bind(reenrollScanCount, Math.ceil(reenrollScanCount / 2), reenrollScanCount, Math.ceil(reenrollScanCount / 2), threshold)
    .all<{ rosterId: string; memberId: string; firstName: string; lastName: string; medianScore: number; lowestScore: number; lastScanAt: string }>();
  return { threshold, scans: reenrollScanCount, members: rows.results ?? [] };
}

/** A completed dashboard enrollment starts the member's score history over. */
export async function recordFingerprintReenrolled(db: D1Database, memberId: string) {
  await db.prepare(`INSERT INTO kiosk_fingerprint_reenrollment(installation_id,member_id,reenrolled_at) SELECT 'primary',id,? FROM members WHERE installation_id='primary' AND id=?
    ON CONFLICT(installation_id,member_id) DO UPDATE SET reenrolled_at=excluded.reenrolled_at`).bind(new Date().toISOString(), memberId).run();
}

const localEnrollmentKeys = new Set(["eventId", "rosterId", "enrolledAt", "pairingId"]);
const invalidLocalEnrollment = () => new HttpError(400, "eventId, rosterId and a valid enrolledAt timestamp are required", undefined, "invalid_enrollment");
/** One audit row per kiosk event, so a resent report is recognized without a table of its own. UUID-shaped like other audit ids. */
async function localEnrollmentAuditId(kioskId: string, eventId: string) {
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`kiosk-local-enrollment\n${kioskId}\n${eventId}`)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(8 | parseInt(hex[16], 16) & 3).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A fingerprint enrolled on the kiosk itself (the maintenance screen), reported from the kiosk's offline queue. It
 * starts the member's score history over like a dashboard enrollment. Only the fact and time arrive, never templates.
 * rosterId is the member's stable roster id (members.id), not the external member ID a scan sends.
 * Idempotent per kiosk event, and reenrolled_at only moves forward, so a late or resent report never rewinds it.
 * A future enrolledAt (a kiosk clock running ahead) counts as now.
 */
export async function recordLocalFingerprintEnrollment(db: D1Database, kiosk: { id: string; pairingId: string; pairingBound: boolean }, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !localEnrollmentKeys.has(key))) throw invalidLocalEnrollment();
  const { eventId, rosterId: memberId, enrolledAt, pairingId } = input as Record<string, unknown>;
  if (typeof eventId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(eventId) || typeof memberId !== "string" || !memberId || memberId.length > 100
    || typeof enrolledAt !== "string" || enrolledAt.length > 40 || !Number.isFinite(Date.parse(enrolledAt)) || pairingId !== undefined && typeof pairingId !== "string") throw invalidLocalEnrollment();
  if ((kiosk.pairingBound || pairingId !== undefined) && pairingId !== kiosk.pairingId) throw new HttpError(409, "This enrollment belongs to a different kiosk pairing", undefined, "pairing_mismatch");
  const now = new Date(), at = new Date(Math.min(Date.parse(enrolledAt), now.getTime())).toISOString();
  const activeMember = "SELECT id FROM members WHERE installation_id='primary' AND id=? AND active=1";
  const [audit, , state] = await db.batch([
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT ?,'primary',NULL,'kiosk.fingerprint_enrolled_locally','kiosk',?,json_object('eventId',?,'rosterId',id,'enrolledAt',?),? FROM (${activeMember}) WHERE 1
      ON CONFLICT(id) DO NOTHING`).bind(await localEnrollmentAuditId(kiosk.id, eventId), kiosk.id, eventId, at, now.toISOString(), memberId),
    db.prepare(`INSERT INTO kiosk_fingerprint_reenrollment(installation_id,member_id,reenrolled_at) SELECT 'primary',id,? FROM (${activeMember}) WHERE 1
      ON CONFLICT(installation_id,member_id) DO UPDATE SET reenrolled_at=excluded.reenrolled_at
      WHERE kiosk_fingerprint_reenrollment.reenrolled_at IS NULL OR julianday(excluded.reenrolled_at)>julianday(kiosk_fingerprint_reenrollment.reenrolled_at)`).bind(at, memberId),
    db.prepare(`SELECT EXISTS(${activeMember}) AS active,(SELECT reenrolled_at FROM kiosk_fingerprint_reenrollment WHERE installation_id='primary' AND member_id=?) AS reenrolledAt`).bind(memberId, memberId),
  ]);
  const row = state?.results?.[0] as { active: number; reenrolledAt: string | null } | undefined;
  // The kiosk drops a report for a member who left the roster instead of retrying it.
  if (!row?.active) throw new HttpError(404, "This fingerprint is not linked to an active roster member", undefined, "roster_inactive");
  const duplicate = (audit?.meta?.changes ?? 0) < 1;
  return { eventId, accepted: !duplicate, duplicate, reenrolledAt: row.reenrolledAt };
}

/** An Admin's dismissal lasts until five new scans after it are below the threshold again. */
export async function dismissReenrollSuggestion(db: D1Database, memberId: string, userId: string) {
  const result = await db.prepare(`INSERT INTO kiosk_fingerprint_reenrollment(installation_id,member_id,dismissed_at,dismissed_by) SELECT 'primary',id,?,? FROM members WHERE installation_id='primary' AND id=?
    ON CONFLICT(installation_id,member_id) DO UPDATE SET dismissed_at=excluded.dismissed_at,dismissed_by=excluded.dismissed_by`).bind(new Date().toISOString(), userId, memberId).run();
  if ((result.meta?.changes ?? 1) < 1) throw new HttpError(404, "Member not found");
}
