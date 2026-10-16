import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

export type ContestSelection = { meetingId: string; memberId: string };

export async function acceptContestBatch(db: D1Database, actor: string, input: unknown) {
  const body = input as { contests?: ContestSelection[]; reviewNote?: string } | null;
  if (!body || !Array.isArray(body.contests) || !body.contests.length || body.contests.length > 100) throw new HttpError(400, "Select between 1 and 100 contests");
  if (typeof body.reviewNote !== "string" || !body.reviewNote.trim() || body.reviewNote.length > 500) throw new HttpError(400, "A review reason of 1 to 500 characters is required");
  const seen = new Set<string>();
  const items = body.contests.map(item => {
    if (!item || typeof item.meetingId !== "string" || !item.meetingId || item.meetingId.length > 128 || typeof item.memberId !== "string" || !item.memberId || item.memberId.length > 128) throw new HttpError(400, "Every contest needs a valid meeting and member");
    const key = JSON.stringify([item.meetingId, item.memberId]);
    if (seen.has(key)) throw new HttpError(400, "Select each contest only once");
    seen.add(key);
    return { meetingId: item.meetingId, memberId: item.memberId, correctionId: crypto.randomUUID(), auditId: crypto.randomUUID() };
  });
  const selected = JSON.stringify(items), reason = body.reviewNote.trim(), now = new Date().toISOString();
  // One transaction and a constant number of queries, including one audit per accepted contest.
  const results = await db.batch([
    db.prepare(`INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at)
      SELECT json_extract(s.value,'$.correctionId'),'primary',c.member_id,c.meeting_id,'present',?,?,?
      FROM json_each(?) s JOIN discord_attendance_contests c ON c.installation_id='primary'
      AND c.meeting_id=json_extract(s.value,'$.meetingId') AND c.member_id=json_extract(s.value,'$.memberId') AND c.status='open'`)
      .bind(`Discord contest approved: ${reason}`, actor, now, selected),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
      SELECT json_extract(s.value,'$.auditId'),'primary',?,'discord.contest_resolved','member',json_extract(s.value,'$.memberId'),
      json_object('meetingId',json_extract(s.value,'$.meetingId'),'resolution','approved','reviewNote',?),?
      FROM json_each(?) s WHERE EXISTS(SELECT 1 FROM attendance_corrections WHERE installation_id='primary' AND id=json_extract(s.value,'$.correctionId'))`)
      .bind(actor, reason, now, selected),
    db.prepare(`UPDATE discord_attendance_contests SET status='approved',resolved_by=?,resolved_at=?,review_note=?
      WHERE installation_id='primary' AND status='open' AND EXISTS(SELECT 1 FROM json_each(?) s
      WHERE meeting_id=json_extract(s.value,'$.meetingId') AND member_id=json_extract(s.value,'$.memberId')
      AND EXISTS(SELECT 1 FROM audit_log WHERE installation_id='primary' AND id=json_extract(s.value,'$.auditId')))`)
      .bind(actor, now, reason, selected),
    db.prepare(`SELECT json_extract(s.value,'$.meetingId') AS meetingId,json_extract(s.value,'$.memberId') AS memberId,
      EXISTS(SELECT 1 FROM audit_log WHERE installation_id='primary' AND id=json_extract(s.value,'$.auditId')) AS resolved FROM json_each(?) s`).bind(selected),
  ]);
  if (results.some(result => result.success === false)) throw new HttpError(503, "Contest acceptance could not be completed");
  return { results: (results.at(-1)?.results as { meetingId: string; memberId: string; resolved: number }[] ?? []).map(item => ({ ...item, resolved: Boolean(item.resolved), ...(!item.resolved ? { error: "Open contest not found. Refresh before retrying." } : {}) })) };
}
