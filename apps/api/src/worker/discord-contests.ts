import { memberDateText } from "../member-date-text.ts";
import { type D1Database } from "../d1-usage.ts";
import { resolveContestBatch } from "../contest-review.ts";
import { HttpError } from "../http-error.ts";
import { requireModuleService } from "../module-platform.ts";
import { captureModuleServiceDatabase } from "../module-database-scope.ts";
import { type Env, allInOrder, authorizedRead, parseJson, requireDatabase, requireRole, response } from "./core.ts";
import { requireDeliveryRunning } from "./delivery.ts";
import { sendDiscordAttendanceNotification } from "./discord-notifications.ts";
import { requireIntegrationConfigured } from "./integration-support.ts";
import { policyReport, policySummaryText } from "./policy-data.ts";

export async function discordMissing(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string }>(request);
  if (!input.meetingId) throw new HttpError(400, "Meeting is required");
  const meeting = await db.prepare("SELECT id, title, starts_at AS startsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<{ id: string; title: string; startsAt: string }>(); if (!meeting) throw new HttpError(404, "Meeting not found"); if (Date.now() < Date.parse(meeting.startsAt)) throw new HttpError(409, "Attendance has not started for this meeting");
  await requireDeliveryRunning(env);
  return response(await sendDiscordAttendanceNotification(env, meeting, { force: true, actor: principal }), 202);
}
export async function discordContests(request: Request, env: Env): Promise<Response> {
  const meetingId = new URL(request.url).searchParams.get("meetingId"); const where = meetingId ? "AND c.meeting_id = ?" : "";
  type ContestRow = Record<string, unknown> & { lifetimeContestCount?: number; hasRawCheckIn?: number; hasRawCheckOut?: number; priorReviewsJson?: string };
  // The Discord check gates the response: allInOrder rethrows its 409 before any contest read result is used.
  const [, [, result]] = await authorizedRead(request, env, ["admin", "operator"], () => allInOrder(() => requireIntegrationConfigured(env, "discord"), () => {
    const statement = requireDatabase(env).prepare(`SELECT c.meeting_id AS meetingId, mt.title AS meetingTitle, mt.starts_at AS meetingStartsAt, c.member_id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, c.status, c.created_at AS createdAt, c.resolved_at AS resolvedAt, c.review_note AS reviewNote, c.prior_reviews_json AS priorReviewsJson, (SELECT SUM(1 + json_array_length(history.prior_reviews_json)) FROM discord_attendance_contests history WHERE history.installation_id = c.installation_id AND history.member_id = c.member_id) AS lifetimeContestCount, EXISTS (SELECT 1 FROM attendance_events check_in WHERE check_in.installation_id = c.installation_id AND check_in.meeting_id = c.meeting_id AND check_in.member_id = c.member_id AND check_in.action = 'check_in') AS hasRawCheckIn, EXISTS (SELECT 1 FROM attendance_events check_out WHERE check_out.installation_id = c.installation_id AND check_out.meeting_id = c.meeting_id AND check_out.member_id = c.member_id AND check_out.action = 'check_out') AS hasRawCheckOut FROM discord_attendance_contests c JOIN members m ON m.id = c.member_id AND m.installation_id = c.installation_id JOIN meetings mt ON mt.id = c.meeting_id AND mt.installation_id = c.installation_id WHERE c.installation_id = 'primary' ${where} ORDER BY CASE WHEN c.status = 'open' THEN 0 ELSE 1 END, c.created_at DESC`);
    return meetingId ? statement.bind(meetingId).all<ContestRow>() : statement.all<ContestRow>();
  }));
  const contests = (result.results ?? []).map(({ hasRawCheckIn, hasRawCheckOut, priorReviewsJson, ...contest }) => ({
    ...contest,
    priorReviews: JSON.parse(priorReviewsJson ?? "[]"),
    lifetimeContestCount: Number(contest.lifetimeContestCount ?? 0),
    hasPartialScan: Boolean(hasRawCheckIn) && !Boolean(hasRawCheckOut),
    rawScanStatus: hasRawCheckIn ? (hasRawCheckOut ? "complete" : "partial") : "none",
  }));
  return response({ contests });
}
export async function resolveDiscordContest(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); await requireIntegrationConfigured(env, "discord"); const db = requireDatabase(env); const input = await parseJson<{ meetingId?: string; memberId?: string; resolution?: "approved" | "rejected" | "reviewed"; reviewNote?: string; createdAt?: string }>(request);
  if (!input.meetingId || !input.memberId || !input.resolution || !["approved", "rejected", "reviewed"].includes(input.resolution)) throw new HttpError(400, "Meeting, member, and a valid resolution are required");
  if (typeof input.reviewNote !== "string" || !input.reviewNote.trim()) throw new HttpError(400, "A review reason is required before resolving this contest");
  if (input.reviewNote.length > 500) throw new HttpError(400, "Review reasons must be 500 characters or fewer");
  const result = await resolveContestBatch(db, principal.userId, { contests: [{ meetingId: input.meetingId, memberId: input.memberId, createdAt: input.createdAt }], reviewNote: input.reviewNote }, input.resolution);
  if (!result.results[0]?.resolved) throw new HttpError(404, "Open contest not found. Refresh before retrying.");
  return response({ resolved: true, attendanceChanged: input.resolution === "approved" });
}
function hexBytes(value: string): Uint8Array { if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) throw new Error("Invalid hexadecimal value"); return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)); }
const byteBuffer = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
export async function verifyDiscordInteraction(request: Request, config: Record<string, string>, body: string): Promise<boolean> {
  const signature = request.headers.get("x-signature-ed25519"); const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60_000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", byteBuffer(hexBytes(config.publicKey)), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, byteBuffer(hexBytes(signature)), byteBuffer(new TextEncoder().encode(timestamp + body)));
  } catch { return false; }
}
export const discordEphemeral = (content: string) => response({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
export async function discordAttendanceReport(db: D1Database, discordUserId: string): Promise<string> {
  const linked = await db.prepare("SELECT id, active FROM members WHERE installation_id = 'primary' AND discord_user_id = ?").bind(discordUserId).all<{ id: string; active: number }>();
  const members = linked.results ?? [];
  if (members.length !== 1 || !members[0].active) return "Your Discord account is not linked to exactly one active LancerLogin roster member. Ask an Operator to check your roster link.";
  const report = await policyReport(db, { meetingType: "all", roster: "all", membership: "current", memberId: members[0].id, useBaseline: true });
  const summary = report.members[0]; if (!summary) return "No roster record was found for this Discord account.";
  const meetings = new Map(report.meetings.map((meeting) => [meeting.id, meeting]));
  const heading = "**Your attendance report**\n" + policySummaryText(summary);
  const absent = summary.rows.filter((row) => row.regularEligible && row.disposition === "absent");
  let content = `${heading}\n\n${absent.length ? "**Missed required meetings**" : "No missed required meetings in the current reporting period."}`;
  for (const row of absent) { const meeting = meetings.get(row.meetingId); const line = `\n• ${meeting ? memberDateText(meeting.startsAt, report.timeZone) : ""} - ${meeting?.title ?? "Meeting"} (${row.audience})`; if ((content + line).length > 1850) { content += "\nMore meetings omitted to fit Discord."; break; } content += line; }
  if (summary.belowTargetWeeks.length) { const line = `\n\nWeeks below target: ${summary.belowTargetWeeks.map((week) => week.weekStartsOn).join(", ")}`; if ((content + line).length <= 2000) content += line; }
  return content;
}
export async function attendanceDiscordDatabase(db: D1Database) {
  const generation = await requireModuleService(db, "attendance");
  return captureModuleServiceDatabase(db, "attendance", generation);
}
