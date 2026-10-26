import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

export type ContestSelection = { meetingId: string; memberId: string; createdAt: string };

export const acceptContestBatch = (db: D1Database, actor: string, input: unknown) => resolveContestBatch(db, actor, input, "approved");
export const rejectContestBatch = (db: D1Database, actor: string, input: unknown) => resolveContestBatch(db, actor, input, "rejected");

export async function resolveContestBatch(db: D1Database, actor: string, input: unknown, resolution: "approved" | "rejected" | "reviewed") {
  const body = input as { contests?: ContestSelection[]; reviewNote?: string } | null;
  if (!body || !Array.isArray(body.contests) || !body.contests.length || body.contests.length > 100) throw new HttpError(400, "Select between 1 and 100 contests");
  if (typeof body.reviewNote !== "string" || !body.reviewNote.trim() || body.reviewNote.length > 500) throw new HttpError(400, "A review reason of 1 to 500 characters is required");
  const seen = new Set<string>();
  const items = body.contests.map(item => {
    if (!item || typeof item.meetingId !== "string" || !item.meetingId || item.meetingId.length > 128 || typeof item.memberId !== "string" || !item.memberId || item.memberId.length > 128) throw new HttpError(400, "Every contest needs a valid meeting and member");
    if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new HttpError(400, "Refresh contests before reviewing: the submission time is required");
    const key = JSON.stringify([item.meetingId, item.memberId]);
    if (seen.has(key)) throw new HttpError(400, "Select each contest only once");
    seen.add(key);
    return { meetingId: item.meetingId, memberId: item.memberId, createdAt: item.createdAt, correctionId: crypto.randomUUID(), auditId: crypto.randomUUID() };
  });
  const selected = JSON.stringify(items), reason = body.reviewNote.trim(), now = new Date().toISOString();
  // One transaction and a constant number of queries, including one audit per resolved contest.
  const results = await db.batch([
    ...(resolution === "approved" ? [db.prepare(`INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at)
      SELECT json_extract(s.value,'$.correctionId'),'primary',c.member_id,c.meeting_id,'present',?,?,?
      FROM json_each(?) s JOIN discord_attendance_contests c ON c.installation_id='primary'
      AND c.meeting_id=json_extract(s.value,'$.meetingId') AND c.member_id=json_extract(s.value,'$.memberId') AND c.created_at=json_extract(s.value,'$.createdAt') AND c.status='open'`)
      .bind(`Discord contest approved: ${reason}`, actor, now, selected)] : []),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT json_extract(s.value,'$.auditId'),'primary',?,'discord.contest_resolved','member',json_extract(s.value,'$.memberId'),
      json_object('meetingId',json_extract(s.value,'$.meetingId'),'resolution',?,'reviewNote',?,'submittedAt',c.created_at),?
      FROM json_each(?) s JOIN discord_attendance_contests c ON c.installation_id='primary' AND c.status='open' AND c.meeting_id=json_extract(s.value,'$.meetingId') AND c.member_id=json_extract(s.value,'$.memberId') AND c.created_at=json_extract(s.value,'$.createdAt')`)
      .bind(actor, resolution, reason, now, selected),
    db.prepare(`UPDATE discord_attendance_contests SET status=?,resolved_by=?,resolved_at=?,review_note=?
      WHERE installation_id='primary' AND status='open' AND EXISTS(SELECT 1 FROM json_each(?) s
      WHERE meeting_id=json_extract(s.value,'$.meetingId') AND member_id=json_extract(s.value,'$.memberId')
      AND EXISTS(SELECT 1 FROM audit_log WHERE installation_id='primary' AND id=json_extract(s.value,'$.auditId')))`)
      .bind(resolution, actor, now, reason, selected),
    db.prepare(`SELECT json_extract(s.value,'$.meetingId') AS meetingId,json_extract(s.value,'$.memberId') AS memberId,
      EXISTS(SELECT 1 FROM audit_log WHERE installation_id='primary' AND id=json_extract(s.value,'$.auditId')) AS resolved FROM json_each(?) s`).bind(selected),
  ]);
  if (results.some(result => result.success === false)) throw new HttpError(503, "Contest review could not be completed");
  return { results: (results.at(-1)?.results as { meetingId: string; memberId: string; resolved: number }[] ?? []).map(item => ({ ...item, resolved: Boolean(item.resolved), ...(!item.resolved ? { error: "Open contest not found. Refresh before retrying." } : {}) })) };
}

// The composite key and conditional upsert make repeated clicks idempotent while a
// request is open. A rejected request is archived atomically before it is reopened.
export async function submitContest(db: D1Database, input: { meetingId: string; memberId: string; messageId: string; discordUserId: string; now: string }) {
  await db.prepare(`INSERT INTO discord_attendance_contests
    (installation_id, meeting_id, member_id, message_id, status, created_at, submitted_by_discord_user_id)
    VALUES ('primary', ?, ?, ?, 'open', ?, ?)
    ON CONFLICT(installation_id, meeting_id, member_id) DO UPDATE SET
      prior_reviews_json = json_insert(discord_attendance_contests.prior_reviews_json, '$[#]', json_object(
        'messageId', discord_attendance_contests.message_id,
        'createdAt', discord_attendance_contests.created_at,
        'submittedByDiscordUserId', discord_attendance_contests.submitted_by_discord_user_id,
        'status', discord_attendance_contests.status,
        'resolvedBy', discord_attendance_contests.resolved_by,
        'resolvedAt', discord_attendance_contests.resolved_at,
        'reviewNote', discord_attendance_contests.review_note)),
      message_id = excluded.message_id,
      created_at = CASE WHEN julianday(excluded.created_at) <= julianday(discord_attendance_contests.created_at)
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', discord_attendance_contests.created_at, '+0.001 seconds') ELSE excluded.created_at END,
      submitted_by_discord_user_id = excluded.submitted_by_discord_user_id,
      status = 'open', resolved_by = NULL, resolved_at = NULL, review_note = NULL
    WHERE discord_attendance_contests.status = 'rejected'
      AND COALESCE((SELECT discord_block_recontests_after_rejection FROM organization_settings WHERE installation_id = 'primary'), 0) = 0`)
    .bind(input.meetingId, input.memberId, input.messageId, input.now, input.discordUserId).run();
}
