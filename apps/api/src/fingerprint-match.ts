import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

// The reader reports a match score with every fingerprint match. Kiosks record it with each uploaded scan, and an
// Admin can require a minimum score; the kiosk asks for a rescan below it instead of recording the match.
export const maximumMinimumScore = 1000;
const retentionMs = 90 * 24 * 60 * 60_000;
const recentMs = 30 * 24 * 60 * 60_000;
const validScore = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 65_535;

/** Best effort: an invalid score is dropped rather than refusing the scan it came with. */
export async function recordScanMatch(db: D1Database, kioskId: string, eventId: unknown, score: unknown) {
  if (!validScore(score) || typeof eventId !== "string" || !eventId.trim() || eventId.length > 100) return;
  const now = new Date();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO kiosk_scan_matches(installation_id,kiosk_event_id,kiosk_id,match_score,recorded_at) VALUES ('primary',?,?,?,?)").bind(eventId.trim(), kioskId, score, now.toISOString()),
    db.prepare("DELETE FROM kiosk_scan_matches WHERE installation_id='primary' AND recorded_at<?").bind(new Date(now.getTime() - retentionMs).toISOString()),
  ]);
}

export async function fingerprintMinimumScore(db: D1Database) {
  return (await db.prepare("SELECT minimum_score AS minimumScore FROM kiosk_fingerprint_match_settings WHERE installation_id='primary'").first<{ minimumScore: number }>())?.minimumScore ?? 0;
}

type Summary = { scans: number; lowest: number | null; below50: number; below100: number; below150: number; below200: number };
/** The setting plus the last 30 days of recorded scores, bucketed so an Admin can choose a minimum. */
export async function readFingerprintMatch(db: D1Database) {
  const [minimumScore, summary] = await Promise.all([fingerprintMinimumScore(db), db.prepare(`SELECT COUNT(*) AS scans,MIN(match_score) AS lowest,
      COALESCE(SUM(match_score<50),0) AS below50,COALESCE(SUM(match_score<100),0) AS below100,COALESCE(SUM(match_score<150),0) AS below150,COALESCE(SUM(match_score<200),0) AS below200
      FROM kiosk_scan_matches WHERE installation_id='primary' AND recorded_at>=?`).bind(new Date(Date.now() - recentMs).toISOString()).first<Summary>()]);
  return { minimumScore, recent: { days: 30, ...(summary ?? { scans: 0, lowest: null, below50: 0, below100: 0, below150: 0, below200: 0 }) } };
}

export function validateMinimumScore(input: unknown) {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "minimumScore")
    || !Number.isInteger(value.minimumScore) || Number(value.minimumScore) < 0 || Number(value.minimumScore) > maximumMinimumScore) throw new HttpError(400, `Minimum match score must be a whole number from 0 to ${maximumMinimumScore}`);
  return Number(value.minimumScore);
}

export async function saveFingerprintMinimumScore(db: D1Database, minimumScore: number) {
  await db.prepare("INSERT INTO kiosk_fingerprint_match_settings(installation_id,minimum_score,updated_at) VALUES ('primary',?,?) ON CONFLICT(installation_id) DO UPDATE SET minimum_score=excluded.minimum_score,updated_at=excluded.updated_at").bind(minimumScore, new Date().toISOString()).run();
}
