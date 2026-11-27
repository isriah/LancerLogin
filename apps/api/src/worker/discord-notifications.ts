import { memberDateText } from "../member-date-text.ts";
import { attendanceAnomalyMinutes, attendanceClosesAt, DEFAULT_ANOMALY_THRESHOLD_MINUTES } from "../attendance-lifecycle.ts";
import { evaluateAttendance, localDate as policyLocalDate, participationStartDate } from "../attendance-policy.ts";
import { type D1Database } from "../d1-usage.ts";
import { SchedulerBudgetError, type PassCost } from "../scheduler-budget.ts";
import { HttpError } from "../http-error.ts";
import { coalescingDatabase } from "../d1-coalesce.ts";
import { DiscordResponseError, type Env, type Principal, parseJson, passAllows, passFits, passMore, requireDatabase, requireRole, response, sha256, writeAudit } from "./core.ts";
import { deliveryPausedUntil } from "./delivery.ts";
import { discordConfiguration, discordRequest } from "./discord-core.ts";
import { integrationRecord, requireIntegrationEnabled } from "./integration-support.ts";
import { policyData } from "./policy-data.ts";

const discordMessageMissing = (error: unknown): error is DiscordResponseError => error instanceof DiscordResponseError && error.discordStatus === 404 && error.discordCode === 10_008;
const discordChannelMissing = (error: unknown): error is DiscordResponseError => error instanceof DiscordResponseError && error.discordStatus === 404 && error.discordCode === 10_003;
type DiscordMessageComponents = { type: number; components: { type: number; style: number; label: string; custom_id: string }[] }[];
export const discordAttendanceReportComponents: DiscordMessageComponents = [{ type: 1, components: [{ type: 2, style: 1, label: "View my attendance report", custom_id: "lancerlogin-attendance-report" }] }];
/**
 * Keeps one Discord message per `stateKey` showing `content`: edits it when the content changed, posts it when there is
 * none, and pins it when asked. Its id and content hash are tracked in integration_state.
 *
 * An unchanged message is checked against Discord (does it still exist, is it still pinned) only when its row was last
 * written `refreshMs` or longer ago; in between it costs no request. The check records its time on the row.
 *
 * Posting is idempotent. A pass may post only after claiming the post in D1, and the claim succeeds only while the
 * tracked row is still what this pass read and no other pass claimed within DISCORD_TRACKED_MESSAGE_CLAIM_MS; a pass
 * that loses resolves unchanged, leaving the message to the winner. The post also carries a nonce derived from the key
 * and content with enforce_nonce, so if a pass is stopped after Discord accepted its message but before the id was
 * saved, a retry within Discord's nonce window gets the same message back instead of a second one.
 */
export async function upsertTrackedDiscordMessage(db: D1Database, config: Record<string, string>, stateKey: string, content: string, pin = false, components?: DiscordMessageComponents, refreshMs = 0): Promise<{ changed: boolean; messageId: string }> {
  const payload = { content, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) };
  const contentHash = await sha256(components ? JSON.stringify({ content, components }) : content); const messagesPath = `/channels/${encodeURIComponent(config.channelId)}/messages`;
  const existing = await db.prepare("SELECT external_id AS externalId, content_hash AS contentHash, updated_at AS updatedAt FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = ?").bind(stateKey).first<{ externalId?: string; contentHash?: string; updatedAt?: string }>();
  let messageId = existing?.externalId ?? ""; let changed = false; let pinned = false; let checked = false;
  if (messageId) {
    const unchanged = existing?.contentHash === contentHash;
    // Checked recently enough: nothing to ask Discord.
    if (unchanged && refreshMs > 0 && Date.parse(existing?.updatedAt ?? "") + refreshMs > Date.now()) return { changed: false, messageId };
    try {
      // An unchanged message is only checked: it still exists, and whether it is still pinned.
      if (unchanged) { pinned = (await discordRequest<{ pinned?: unknown }>(config, `${messagesPath}/${encodeURIComponent(messageId)}`, { method: "GET" })).body?.pinned === true; checked = true; }
      else {
        const { body } = await discordRequest(config, `${messagesPath}/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify(payload) });
        messageId = String(body.id ?? messageId); changed = true;
      }
    } catch (error) {
      if (!discordMessageMissing(error)) throw error;
      messageId = "";
    }
  }
  const claimKey = `${stateKey}:post-claim`; let claimed = false;
  if (!messageId) {
    const now = new Date();
    const claim = await db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, updated_at) SELECT 'primary', 'discord', ?, ?, ? WHERE COALESCE((SELECT external_id FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = ?), '') = ? ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, updated_at = excluded.updated_at WHERE integration_state.updated_at < ?")
      .bind(claimKey, contentHash, now.toISOString(), stateKey, existing?.externalId ?? "", new Date(now.getTime() - DISCORD_TRACKED_MESSAGE_CLAIM_MS).toISOString()).run();
    // Another pass is posting this message, or already has.
    if ((claim.meta?.changes ?? 1) !== 1) return { changed: false, messageId: "" };
    claimed = true;
    const nonce = (await sha256(`discord-tracked-message:primary:${stateKey}:${contentHash}`)).slice(0, 25);
    const { body } = await discordRequest(config, messagesPath, { method: "POST", body: JSON.stringify({ ...payload, nonce, enforce_nonce: true }) });
    messageId = String(body.id ?? ""); changed = true;
    if (!messageId) throw new HttpError(502, "Discord did not return a managed message identifier");
  }
  // The recorded message and content only change when Discord's did, and a message Discord reports pinned stays pinned.
  // A check with nothing to change records only its time, so the next one waits for the refresh interval.
  if (changed || checked || messageId !== existing?.externalId || existing?.contentHash !== contentHash) {
    const now = new Date().toISOString();
    const write = db.prepare("INSERT INTO integration_state (installation_id, provider, state_key, external_id, content_hash, updated_at) VALUES ('primary', 'discord', ?, ?, ?, ?) ON CONFLICT(installation_id, provider, state_key) DO UPDATE SET external_id = excluded.external_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at").bind(stateKey, messageId, contentHash, now);
    // The claim is released with the write that makes it unnecessary: later passes read the new message id.
    if (claimed) await db.batch([write, db.prepare("DELETE FROM integration_state WHERE installation_id = 'primary' AND provider = 'discord' AND state_key = ?").bind(claimKey)]);
    else await write.run();
  }
  if (pin && !pinned) await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages/pins/${encodeURIComponent(messageId)}`, { method: "PUT" });
  return { changed, messageId };
}
export async function linkDiscordMember(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); await requireIntegrationEnabled(env, "discord"); const db = requireDatabase(env); const input = await parseJson<{ memberId?: string; discordUserId?: string | null }>(request);
  if (!input.memberId || (input.discordUserId !== null && !/^\d{10,24}$/.test(input.discordUserId ?? ""))) throw new HttpError(400, "Member and a valid Discord user ID are required");
  await db.prepare("UPDATE members SET discord_user_id = ? WHERE installation_id = 'primary' AND id = ?").bind(input.discordUserId, input.memberId).run();
  await writeAudit(db, principal, input.discordUserId ? "discord.member_linked" : "discord.member_unlinked", "member", input.memberId);
  return response({ linked: Boolean(input.discordUserId), memberId: input.memberId });
}
export async function linkedAbsentMembers(db: D1Database, meetingId: string): Promise<{ id: string; discordUserId: string }[]> {
  // The evaluation's nine policy reads start together, so they go to D1 as one batch: one query against the
  // invocation's limit instead of nine.
  const data = await policyData(coalescingDatabase(db), { meetingId }); const meeting = data.meetings.find((item) => item.id === meetingId);
  if (!meeting || !meeting.required) return [];
  const expected = new Set(evaluateAttendance({ ...data, meetings: [meeting], now: new Date(Math.max(Date.now(), Date.parse(meeting.attendanceClosesAt) + 1)).toISOString() }).filter((item) => item.member.active && item.rows.some((row) => row.meetingId === meetingId && row.eligibility === "required" && (row.disposition === "absent" || Date.now() >= Date.parse(meeting.attendanceClosesAt) && row.disposition === "active"))).map((item) => item.member.id));
  // The evaluation above projects to the close, where an open check-in counts as absent. Until then that member is still attending.
  if (Date.now() < Date.parse(meeting.attendanceClosesAt)) for (const observation of data.observations) if (observation.meetingId === meetingId && observation.disposition === "active") expected.delete(observation.memberId);
  if (!expected.size) return [];
  const linked = await db.prepare("SELECT id, discord_user_id AS discordUserId FROM members WHERE installation_id = 'primary' AND active = 1 AND discord_user_id IS NOT NULL").all<{ id: string; discordUserId: string }>();
  return (linked.results ?? []).filter((member) => expected.has(member.id));
}
const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;
const DISCORD_ALLOWED_MENTION_LIMIT = 100;
type DiscordAttendanceMember = { id: string; discordUserId: string };
function discordAttendancePayload(meeting: { id: string; title: string }, members: DiscordAttendanceMember[]) {
  const userIds = members.map((member) => member.discordUserId);
  const mentions = userIds.map((id) => `<@${id}>`).join(" ");
  return {
    content: `Attendance has closed for **${meeting.title}**. The following members are marked absent: ${mentions}\nIf you attended, use the button below to request a private review. Your attendance will not change until an Operator or Admin approves it. Ask general questions in the thread under the first message in this notice.`,
    allowed_mentions: { parse: [], users: userIds },
    components: [{ type: 1, components: [{ type: 2, style: 2, label: "Contest absence", custom_id: `lancerlogin-attendance:${meeting.id}` }] }],
  };
}
function discordAttendanceChunks(meeting: { id: string; title: string }, members: DiscordAttendanceMember[]): DiscordAttendanceMember[][] {
  const chunks: DiscordAttendanceMember[][] = [];
  let current: DiscordAttendanceMember[] = [];
  for (const member of members) {
    const candidate = [...current, member];
    if (candidate.length > DISCORD_ALLOWED_MENTION_LIMIT || discordAttendancePayload(meeting, candidate).content.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
      if (!current.length) throw new HttpError(500, "Discord attendance notice text leaves no room for a member mention");
      chunks.push(current);
      current = [member];
      if (discordAttendancePayload(meeting, current).content.length > DISCORD_MESSAGE_CONTENT_LIMIT) throw new HttpError(500, "Discord attendance notice text leaves no room for a member mention");
    } else current = candidate;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
/**
 * How long after its last attempt a failed Discord notice or anomaly report may be tried again: the calendar operations'
 * backoff (one minute, doubling from 2^attempts seconds, at most an hour), and never again once it has been attempted
 * DISCORD_DELIVERY_MAX_ATTEMPTS times. A row with no readable time is due.
 */
const DISCORD_DELIVERY_MAX_ATTEMPTS = 16;
const discordDeliveryRetryDelay = (attempts: number) => Math.min(3_600_000, Math.max(60_000, 2 ** Math.min(Math.max(attempts, 0), 12) * 1_000));
function discordDeliveryRetryDue(attempts: number | null | undefined, updatedAt: string | null | undefined, now: number): boolean {
  const count = Number(attempts ?? 0); if (count >= DISCORD_DELIVERY_MAX_ATTEMPTS) return false;
  const last = Date.parse(updatedAt ?? ""); return !Number.isFinite(last) || last + discordDeliveryRetryDelay(count) <= now;
}
/**
 * A notice still `pending` this long after its last write is one whose delivery never reached its own ending: the
 * invocation was stopped (a platform limit, a deploy) before it could record success or failure. The scheduler then
 * takes it up again; the recipients already recorded for its delivery are not mentioned twice.
 */
const DISCORD_ATTENDANCE_PENDING_STALE_MS = 10 * 60_000;
export async function sendDiscordAttendanceNotification(env: Env, meeting: { id: string; title: string }, options: { force?: boolean; actor?: Principal; contestWindowHours?: number } = {}): Promise<{ posted: boolean; duplicate?: boolean; linkedMissingCount: number; messageId?: string }> {
  const config = await discordConfiguration(env); const db = requireDatabase(env); const now = new Date().toISOString();
  const existing = await db.prepare("SELECT status, message_id AS messageId, attempts, delivery_id AS deliveryId FROM discord_attendance_notifications WHERE installation_id = 'primary' AND meeting_id = ?").bind(meeting.id).first<{ status: string; messageId?: string; attempts: number; deliveryId?: string }>();
  if (!options.force && ["delivered", "no_recipients"].includes(existing?.status ?? "")) return { posted: existing?.status === "delivered", duplicate: true, linkedMissingCount: 0, messageId: existing?.messageId };
  const resume = Boolean(existing?.deliveryId && ["pending", "failed"].includes(existing.status));
  const deliveryId = resume ? existing!.deliveryId! : crypto.randomUUID();
  if (!existing) await db.prepare("INSERT INTO discord_attendance_notifications (installation_id, meeting_id, status, attempts, updated_at, channel_id, delivery_id) VALUES ('primary', ?, 'pending', 1, ?, ?, ?)").bind(meeting.id, now, config.channelId, deliveryId).run();
  else if (resume) await db.prepare("UPDATE discord_attendance_notifications SET status = 'pending', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND delivery_id = ?").bind(now, meeting.id, deliveryId).run();
  else await db.prepare("UPDATE discord_attendance_notifications SET status = 'pending', message_id = NULL, attempts = attempts + 1, last_error = NULL, processed_at = NULL, updated_at = ?, channel_id = ?, expires_at = NULL, deleted_at = NULL, thread_created_at = NULL, delivery_id = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(now, config.channelId, deliveryId, meeting.id).run();
  // Everything after the `pending` write is inside the try, so any failure (the absence evaluation included) is
  // recorded as failed with its reason and retried with backoff instead of leaving the notice pending.
  try {
    const members = await linkedAbsentMembers(db, meeting.id);
    if (!members.length) {
      await db.prepare("UPDATE discord_attendance_notifications SET status = 'no_recipients', processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND delivery_id = ?").bind(now, now, meeting.id, deliveryId).run();
      return { posted: false, linkedMissingCount: 0 };
    }
    const delivered = resume ? await db.prepare("SELECT member_id AS memberId, message_id AS messageId FROM discord_attendance_recipients WHERE installation_id = 'primary' AND meeting_id = ? AND delivery_id = ? ORDER BY delivered_at, message_id").bind(meeting.id, deliveryId).all<{ memberId: string; messageId: string }>() : { results: [] };
    const deliveredRows = delivered.results ?? [];
    const deliveredMemberIds = new Set(deliveredRows.map((row) => row.memberId));
    const remaining = members.filter((member) => !deliveredMemberIds.has(member.id));
    let messageId = resume ? existing?.messageId ?? deliveredRows[0]?.messageId : undefined;
    for (const chunk of discordAttendanceChunks(meeting, remaining)) {
      const payload = discordAttendancePayload(meeting, chunk);
      const { body } = await discordRequest(config, `/channels/${encodeURIComponent(config.channelId)}/messages`, { method: "POST", body: JSON.stringify(payload) });
      const chunkMessageId = String(body.id ?? "");
      if (!chunkMessageId) throw new HttpError(502, "Discord did not return a message identifier");
      const deliveredAt = new Date().toISOString();
      await db.batch([
        ...chunk.map((member) => db.prepare("INSERT OR IGNORE INTO discord_attendance_recipients (installation_id, meeting_id, member_id, discord_user_id, message_id, delivered_at, delivery_id) VALUES ('primary', ?, ?, ?, ?, ?, ?)").bind(meeting.id, member.id, member.discordUserId, chunkMessageId, deliveredAt, deliveryId)),
        db.prepare("UPDATE discord_attendance_notifications SET message_id = COALESCE(message_id, ?), channel_id = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND delivery_id = ?").bind(chunkMessageId, config.channelId, deliveredAt, meeting.id, deliveryId),
      ]);
      messageId ??= chunkMessageId;
    }
    if (!messageId) throw new HttpError(502, "Discord attendance delivery has no tracked message identifier");
    // The scheduled job has already read the contest window with its other settings.
    const contestWindowHours = options.contestWindowHours ?? (await db.prepare("SELECT discord_contest_window_hours AS contestWindowHours FROM organization_settings WHERE installation_id = 'primary'").first<{ contestWindowHours?: number }>())?.contestWindowHours ?? 24;
    const expiresAt = new Date(Date.parse(now) + contestWindowHours * 3_600_000).toISOString();
    await db.prepare("UPDATE discord_attendance_notifications SET status = 'delivered', message_id = ?, channel_id = ?, expires_at = ?, deleted_at = NULL, thread_created_at = NULL, processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND delivery_id = ?").bind(messageId, config.channelId, expiresAt, now, now, meeting.id, deliveryId).run();
    try { await createDiscordAttendanceThread(db, config, { meetingId: meeting.id, messageId, channelId: config.channelId, title: meeting.title }); } catch { /* The delivered notice remains tracked for a scheduled thread retry. */ }
    if (options.actor) await writeAudit(db, options.actor, "discord.missing_notified", "meeting", meeting.id, { linkedMissingCount: members.length, messageId, manual: true });
    return { posted: true, linkedMissingCount: members.length, messageId };
  } catch (error) {
    // If this write cannot run either (the invocation is out of subrequests), the notice stays pending and the
    // scheduler takes it up again once it is DISCORD_ATTENDANCE_PENDING_STALE_MS old.
    await db.prepare("UPDATE discord_attendance_notifications SET status = 'failed', last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND delivery_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord delivery failed", new Date().toISOString(), meeting.id, deliveryId).run();
    throw error;
  }
}
async function createDiscordAttendanceThread(db: D1Database, config: Record<string, string>, notice: { meetingId: string; messageId: string; channelId: string; title: string }): Promise<void> {
  const path = `/channels/${encodeURIComponent(notice.channelId)}/messages/${encodeURIComponent(notice.messageId)}/threads`;
  try {
    await discordRequest(config, path, { method: "POST", body: JSON.stringify({ name: `Attendance questions - ${discordReportText(notice.title, 70) || "meeting"}` }) });
  } catch (error) {
    // Discord may have created the thread even if the response was lost. Its ID is the starter message ID.
    let exists = false;
    try {
      const { body } = await discordRequest<{ id?: string; parent_id?: string }>(config, `/channels/${encodeURIComponent(notice.messageId)}`, { method: "GET" });
      exists = body.id === notice.messageId && body.parent_id === notice.channelId;
    } catch { /* Retry creation on the next scheduled pass. */ }
    if (!exists) {
      await db.prepare("UPDATE discord_attendance_notifications SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord thread creation failed", new Date().toISOString(), notice.meetingId, notice.messageId).run();
      return;
    }
  }
  const createdAt = new Date().toISOString();
  await db.prepare("UPDATE discord_attendance_notifications SET thread_created_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(createdAt, createdAt, notice.meetingId, notice.messageId).run();
}
// Per pass: an expiry costs 2 or more Discord deletions and about 5 D1 queries, and a thread retry one Discord request.
// A notice costs up to 13 D1 queries when it fits one message: its own row (2), the absence evaluation (the report
// revision before and after, the policy reads as one batch, and the linked members), the recipients already delivered
// when it resumes, one batch per message, the delivered update and the thread's update, and the module authority check
// that precedes each Discord request; and up to 3 Discord requests (the message, its thread, and a check when the
// thread request fails). Each further message of a long absence list adds two queries and a request. (Before the policy
// reads were batched a notice took about 20 queries against a budget of 12.) Notices left over are found again on the
// next pass.
const DISCORD_ATTENDANCE_NOTICES_PER_PASS = 2;
const DISCORD_ATTENDANCE_EXPIRIES_PER_PASS = 2;
const DISCORD_ATTENDANCE_THREAD_RETRIES_PER_PASS = 2;
const DISCORD_ATTENDANCE_NOTICE_COST: PassCost = { d1: 13, external: 3 };
const DISCORD_ATTENDANCE_EXPIRY_COST: PassCost = { d1: 6, external: 3 };
const DISCORD_ATTENDANCE_THREAD_COST: PassCost = { d1: 3, external: 1 };
async function retryDiscordAttendanceThreads(env: Env, config: Record<string, string>, now: number): Promise<void> {
  const db = requireDatabase(env);
  const notices = await db.prepare("SELECT n.meeting_id AS meetingId, n.message_id AS messageId, n.channel_id AS channelId, m.title FROM discord_attendance_notifications n JOIN meetings m ON m.installation_id = n.installation_id AND m.id = n.meeting_id WHERE n.installation_id = 'primary' AND n.status = 'delivered' AND n.message_id IS NOT NULL AND n.thread_created_at IS NULL AND n.deleted_at IS NULL AND n.expires_at > ? LIMIT 100").bind(new Date(now).toISOString()).all<{ meetingId: string; messageId: string; channelId: string; title: string }>();
  const retries = (notices.results ?? []).filter((notice) => notice.channelId === config.channelId).slice(0, DISCORD_ATTENDANCE_THREAD_RETRIES_PER_PASS);
  for (const notice of retries) { if (!passAllows(env, DISCORD_ATTENDANCE_THREAD_COST)) break; await createDiscordAttendanceThread(db, config, notice); }
}
async function expireDiscordAttendanceNotifications(env: Env, config: Record<string, string>, contestWindowHours: number, now: number): Promise<void> {
  const db = requireDatabase(env);
  const delivered = await db.prepare("SELECT meeting_id AS meetingId, message_id AS messageId, channel_id AS channelId, processed_at AS processedAt, expires_at AS expiresAt, delivery_id AS deliveryId FROM discord_attendance_notifications WHERE installation_id = 'primary' AND status = 'delivered' AND message_id IS NOT NULL AND deleted_at IS NULL").all<{ meetingId: string; messageId: string; channelId?: string; processedAt?: string; expiresAt?: string; deliveryId?: string }>();
  let attempted = 0;
  for (const notice of delivered.results ?? []) {
    const expiry = notice.expiresAt ? Date.parse(notice.expiresAt) : Date.parse(notice.processedAt ?? "") + contestWindowHours * 3_600_000;
    if (!Number.isFinite(expiry) || expiry > now || notice.channelId && notice.channelId !== config.channelId) continue;
    if (attempted >= DISCORD_ATTENDANCE_EXPIRIES_PER_PASS || !passAllows(env, DISCORD_ATTENDANCE_EXPIRY_COST)) break;
    attempted += 1;
    if (!(await deleteDiscordAttendanceMessages(db, config, notice))) continue;
    const deletedAt = new Date(now).toISOString();
    await db.prepare("UPDATE discord_attendance_notifications SET deleted_at = ?, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(deletedAt, deletedAt, notice.meetingId, notice.messageId).run();
  }
}
// Deletes every chunk of a delivered notice and its question thread. A refused deletion is recorded on the notice and reported as false.
async function deleteDiscordAttendanceMessages(db: D1Database, config: Record<string, string>, notice: { meetingId: string; messageId: string; deliveryId?: string }): Promise<boolean> {
  const messageIds = new Set([notice.messageId]);
  if (notice.deliveryId) {
    const chunks = await db.prepare("SELECT DISTINCT message_id AS messageId FROM discord_attendance_recipients WHERE installation_id = 'primary' AND meeting_id = ? AND delivery_id = ?").bind(notice.meetingId, notice.deliveryId).all<{ messageId: string }>();
    for (const chunk of chunks.results ?? []) messageIds.add(chunk.messageId);
  }
  // Discord keeps a thread when its starter message is deleted. The thread's ID is the starter message ID.
  const paths = [...[...messageIds].map((messageId) => `/channels/${encodeURIComponent(config.channelId)}/messages/${encodeURIComponent(messageId)}`), `/channels/${encodeURIComponent(notice.messageId)}`];
  let failed = false;
  for (const path of paths) {
    try {
      await discordRequest(config, path, { method: "DELETE" });
    } catch (error) {
      if (!discordMessageMissing(error) && !discordChannelMissing(error)) {
        await db.prepare("UPDATE discord_attendance_notifications SET last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord deletion failed", new Date().toISOString(), notice.meetingId).run();
        failed = true;
      }
    }
  }
  return !failed;
}
type DiscordNoticeRetraction = { meetingId: string; outcome: "retracted" | "pending_deletion" | "failed" };
// A meeting edit can change who is absent, so a live notice evaluated against the old schedule is withdrawn. Removing its tracking
// row lets the scheduler post a fresh notice once the edited meeting's attendance closes, or on its next pass when that has passed.
// A deletion Discord refuses expires the notice instead, so the scheduled cleanup keeps retrying and no new notice is posted.
// At most `inlineLimit` notices are withdrawn by the request itself; the rest expire now in one statement, as a CSV import's do,
// so a request's cost does not grow with the number of meetings it edits.
export async function retractDiscordAttendanceNotices(env: Env, principal: Principal, meetingIds: string[], inlineLimit = Number.POSITIVE_INFINITY): Promise<DiscordNoticeRetraction[]> {
  if (!meetingIds.length) return [];
  const db = requireDatabase(env); const now = new Date().toISOString();
  const notices = await db.prepare("SELECT meeting_id AS meetingId, message_id AS messageId, channel_id AS channelId, delivery_id AS deliveryId FROM discord_attendance_notifications WHERE installation_id = 'primary' AND meeting_id IN (SELECT value FROM json_each(?)) AND status = 'delivered' AND message_id IS NOT NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").bind(JSON.stringify(meetingIds), now).all<{ meetingId: string; messageId: string; channelId?: string; deliveryId?: string }>();
  const outcomes: DiscordNoticeRetraction[] = []; const live = notices.results ?? []; const later = live.slice(inlineLimit);
  if (later.length) {
    try { await db.prepare("UPDATE discord_attendance_notifications SET expires_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id IN (SELECT value FROM json_each(?)) AND status = 'delivered' AND message_id IS NOT NULL AND deleted_at IS NULL").bind(now, now, JSON.stringify(later.map((notice) => notice.meetingId))).run(); } catch { /* The meeting edit is saved; the stale notices still expire on schedule. */ }
  }
  for (const notice of live.slice(0, inlineLimit)) {
    let outcome: DiscordNoticeRetraction["outcome"] = "failed";
    try {
      const config = await discordConfiguration(env);
      if (notice.channelId && notice.channelId !== config.channelId || await deliveryPausedUntil(env) !== null || !(await deleteDiscordAttendanceMessages(db, config, notice))) {
        await db.prepare("UPDATE discord_attendance_notifications SET expires_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(now, now, notice.meetingId, notice.messageId).run();
        outcome = "pending_deletion";
      } else {
        await db.prepare("DELETE FROM discord_attendance_notifications WHERE installation_id = 'primary' AND meeting_id = ? AND message_id = ?").bind(notice.meetingId, notice.messageId).run();
        outcome = "retracted";
      }
      await writeAudit(db, principal, "discord.missing_notice_retracted", "meeting", notice.meetingId, { outcome, messageId: notice.messageId });
    } catch { /* The meeting edit is saved; the stale notice still expires on schedule. */ }
    outcomes.push({ meetingId: notice.meetingId, outcome });
  }
  return [...outcomes, ...later.map((notice) => ({ meetingId: notice.meetingId, outcome: "pending_deletion" as const }))];
}
export async function processDiscordAttendanceNotifications(env: Env, now = Date.now()): Promise<void> {
  const discord = await integrationRecord(env, "discord"); if (!discord || discord.enabled === 0 || !discord.verifiedAt) return;
  if (await deliveryPausedUntil(env) !== null) return;
  const db = requireDatabase(env); const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, discord_contest_window_hours AS contestWindowHours FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number; contestWindowHours?: number }>();
  const config = await discordConfiguration(env);
  await expireDiscordAttendanceNotifications(env, config, settings?.contestWindowHours ?? 24, now);
  await retryDiscordAttendanceThreads(env, config, now);
  const meetings = await db.prepare("SELECT m.id, m.title, m.ends_at AS endsAt, n.status AS notificationStatus, n.updated_at AS notificationUpdatedAt, n.attempts AS notificationAttempts FROM meetings m LEFT JOIN discord_attendance_notifications n ON n.installation_id = m.installation_id AND n.meeting_id = m.id WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.required = 1 AND m.is_test = 0 AND m.ends_at IS NOT NULL ORDER BY m.ends_at DESC LIMIT 100").all<{ id: string; title: string; endsAt: string; notificationStatus?: string; notificationUpdatedAt?: string; notificationAttempts?: number }>();
  // Notices never attempted go first. A failed notice, or one left pending by an invocation that was stopped, is tried
  // again only when its backoff has passed, and no longer once it has used its attempts (Send Discord absence notice on the meeting still sends it).
  const fresh = [], retries = [];
  for (const meeting of meetings.results ?? []) {
    if (!meeting.notificationStatus) { if (Date.parse(attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30)) <= now) fresh.push(meeting); continue; }
    const stale = meeting.notificationStatus === "pending" && !(Date.parse(meeting.notificationUpdatedAt ?? "") + DISCORD_ATTENDANCE_PENDING_STALE_MS > now);
    if ((meeting.notificationStatus === "failed" || stale) && discordDeliveryRetryDue(meeting.notificationAttempts, meeting.notificationUpdatedAt, now)) retries.push(meeting);
  }
  let sent = 0;
  for (const meeting of [...fresh, ...retries]) {
    // Only new notices ask for another slice right away; retries wait for the job's normal interval and their backoff.
    if (sent >= DISCORD_ATTENDANCE_NOTICES_PER_PASS) { if (!meeting.notificationStatus) passMore(env); break; }
    // A new notice the budget cannot cover asks for another slice; a retry waits for the job's next regular run.
    if (!(meeting.notificationStatus ? passFits(env, DISCORD_ATTENDANCE_NOTICE_COST) : passAllows(env, DISCORD_ATTENDANCE_NOTICE_COST))) break;
    sent += 1;
    // One notice that fails (it is recorded as failed) must not hold back the others.
    try { await sendDiscordAttendanceNotification(env, meeting, { contestWindowHours: settings?.contestWindowHours ?? 24 }); } catch (error) { if (error instanceof SchedulerBudgetError) throw error; }
  }
}
type DiscordAnomalyRow = { memberId: string; firstName: string; lastName: string; checkedInAt?: string; checkedOutAt?: string; lateMinutes?: number; earlyMinutes?: number };
const discordReportText = (value: string, limit: number) => value.replace(/[\r\n\t]+/g, " ").replace(/[\\`*_~|<>@]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
const discordReportMinutes = (minutes: number) => Number(minutes.toFixed(1)).toString();
function discordAnomalyReportContent(meeting: { title: string; startsAt: string }, rows: DiscordAnomalyRow[], timeZone: string): string {
  const header = `**Attendance anomalies · ${discordReportText(meeting.title, 120)}**\nMeeting date: ${memberDateText(meeting.startsAt, timeZone)}`;
  const lines = rows.map((row) => {
    const values = [row.lateMinutes !== undefined ? `arrived ${discordReportMinutes(row.lateMinutes)} min late` : "", row.earlyMinutes !== undefined ? `left ${discordReportMinutes(row.earlyMinutes)} min early` : ""].filter(Boolean).join("; ");
    return `• ${discordReportText(`${row.firstName} ${row.lastName}`, 120)} (${discordReportText(row.memberId, 80)}) — ${values}`;
  });
  const included: string[] = [];
  for (const line of lines) {
    if (`${header}\n${[...included, line].join("\n")}`.length > 1_900) break;
    included.push(line);
  }
  const omitted = lines.length - included.length;
  return `${header}\n${included.join("\n")}${omitted ? `\n… ${omitted} more anomalous member${omitted === 1 ? "" : "s"} omitted.` : ""}`;
}
async function sendDiscordAnomalyReport(env: Env, config: Record<string, string>, channelId: string, meeting: { id: string; title: string; startsAt: string; endsAt: string }, thresholds: { late: number; early: number }, timeZone: string): Promise<void> {
  const db = requireDatabase(env); const now = new Date().toISOString();
  const existing = await db.prepare("SELECT status, nonce, message_id AS messageId, attempts FROM discord_anomaly_reports WHERE installation_id = 'primary' AND meeting_id = ?").bind(meeting.id).first<{ status: string; nonce?: string; messageId?: string; attempts: number }>();
  if (["delivered", "no_anomalies"].includes(existing?.status ?? "")) return;
  const nonce = existing?.nonce ?? (await sha256(`discord-anomaly-report:primary:${meeting.id}`)).slice(0, 25);
  if (!existing) await db.prepare("INSERT INTO discord_anomaly_reports (installation_id, meeting_id, channel_id, status, nonce, attempts, updated_at) VALUES ('primary', ?, ?, 'pending', ?, 1, ?)").bind(meeting.id, channelId, nonce, now).run();
  else await db.prepare("UPDATE discord_anomaly_reports SET channel_id = ?, status = 'pending', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(channelId, now, meeting.id).run();
  // From here every failure is recorded on the report, so it is retried with backoff rather than left pending.
  try {
    const raw = await db.prepare("SELECT m.external_id AS memberId, m.first_name AS firstName, m.last_name AS lastName, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_out') AS checkedOutAt, m.attendance_required_from AS attendanceRequiredFrom, m.created_at AS rosterAddedAt, (SELECT time_zone FROM organization_settings WHERE installation_id = 'primary') AS timeZone FROM members m WHERE m.installation_id = 'primary' AND (EXISTS (SELECT 1 FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ?) OR EXISTS (SELECT 1 FROM attendance_events e WHERE e.installation_id = m.installation_id AND e.member_id = m.id AND e.meeting_id = ?)) ORDER BY m.last_name, m.first_name, m.external_id").bind(meeting.id, meeting.id, meeting.id, meeting.id).all<Omit<DiscordAnomalyRow, "lateMinutes" | "earlyMinutes"> & { attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null; timeZone?: string | null }>();
    // Participation starts on an organization-local date, so the meeting's local date decides (the same read carries the time zone).
    const participating = (raw.results ?? []).filter((row) => { const timeZone = row.timeZone || "UTC"; const startsOn = participationStartDate(row, timeZone); return !startsOn || startsOn <= policyLocalDate(meeting.startsAt, timeZone); });
    const anomalies = participating.flatMap(({ attendanceRequiredFrom: _from, rosterAddedAt: _added, timeZone: _zone, ...row }) => {
      const values = attendanceAnomalyMinutes({ ...meeting, ...row }, thresholds.late, thresholds.early);
      return values.lateMinutes === undefined && values.earlyMinutes === undefined ? [] : [{ ...row, ...values }];
    });
    if (!anomalies.length) {
      await db.prepare("UPDATE discord_anomaly_reports SET status = 'no_anomalies', processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(now, now, meeting.id).run();
      return;
    }
    const payload = { content: discordAnomalyReportContent(meeting, anomalies, timeZone), allowed_mentions: { parse: [] }, nonce, enforce_nonce: true };
    const { body } = await discordRequest(config, `/channels/${encodeURIComponent(channelId)}/messages`, { method: "POST", body: JSON.stringify(payload) });
    const messageId = String(body.id ?? "");
    if (!messageId) throw new HttpError(502, "Discord did not return an anomaly-report message identifier");
    const processedAt = new Date().toISOString();
    await db.prepare("UPDATE discord_anomaly_reports SET status = 'delivered', message_id = ?, last_error = NULL, processed_at = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(messageId, processedAt, processedAt, meeting.id).run();
  } catch (error) {
    await db.prepare("UPDATE discord_anomaly_reports SET status = 'failed', last_error = ?, updated_at = ? WHERE installation_id = 'primary' AND meeting_id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : "Discord delivery failed", new Date().toISOString(), meeting.id).run();
    throw error;
  }
}
// Per pass: one Discord message and about 5 D1 queries per report. Reports left over stay pending for the next pass.
// Reports never attempted go first, oldest meeting first. One that failed (or was left pending by an invocation that
// was stopped) is tried again only after its backoff, and no longer once it has used DISCORD_DELIVERY_MAX_ATTEMPTS, so
// reports that keep failing can neither crowd out a new one nor keep the job asking for another slice.
const DISCORD_ANOMALY_REPORTS_PER_PASS = 3;
const DISCORD_ANOMALY_REPORT_COST: PassCost = { d1: 6, external: 1 };
export async function processDiscordAnomalyReports(env: Env, now = Date.now()): Promise<void> {
  const discord = await integrationRecord(env, "discord"); if (!discord || discord.enabled === 0 || !discord.verifiedAt) return;
  const db = requireDatabase(env);
  const settings = await db.prepare("SELECT late_scan_minutes AS lateScanMinutes, anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes, anomaly_early_threshold_minutes AS anomalyEarlyThresholdMinutes, discord_anomaly_reports_enabled AS enabled, discord_anomaly_report_channel_id AS channelId, discord_anomaly_reports_enabled_at AS enabledAt, time_zone AS timeZone FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes?: number; anomalyLateThresholdMinutes?: number; anomalyEarlyThresholdMinutes?: number; enabled?: number; channelId?: string; enabledAt?: string; timeZone?: string | null }>();
  if (!settings?.enabled || !settings.channelId || !settings.enabledAt) return;
  const lateScanMinutes = settings.lateScanMinutes ?? 30; const enabledAt = Date.parse(settings.enabledAt);
  if (!Number.isFinite(enabledAt)) return;
  const earliestEnd = new Date(enabledAt - lateScanMinutes * 60_000).toISOString();
  // Only meetings that have ended can be due, so meetings still to come no longer take up the 100 rows.
  const meetings = await db.prepare("SELECT m.id, m.title, m.starts_at AS startsAt, m.ends_at AS endsAt, r.status AS reportStatus, r.attempts AS reportAttempts, r.updated_at AS reportUpdatedAt FROM meetings m LEFT JOIN discord_anomaly_reports r ON r.installation_id = m.installation_id AND r.meeting_id = m.id WHERE m.installation_id = 'primary' AND m.deleted_at IS NULL AND m.is_test = 0 AND m.ends_at IS NOT NULL AND m.ends_at >= ? AND m.ends_at <= ? AND (r.status IS NULL OR (r.status IN ('pending', 'failed') AND r.attempts < ?)) ORDER BY (r.status IS NOT NULL), m.ends_at ASC LIMIT 100").bind(earliestEnd, new Date(now).toISOString(), DISCORD_DELIVERY_MAX_ATTEMPTS).all<{ id: string; title: string; startsAt: string; endsAt: string; reportStatus?: string; reportAttempts?: number; reportUpdatedAt?: string }>();
  if (await deliveryPausedUntil(env) !== null) return;
  const config = await discordConfiguration(env); let attempted = 0;
  for (const meeting of meetings.results ?? []) {
    const cutoff = Date.parse(attendanceClosesAt(meeting.endsAt, lateScanMinutes));
    if (cutoff < enabledAt || cutoff > now) continue;
    if (meeting.reportStatus && !discordDeliveryRetryDue(meeting.reportAttempts, meeting.reportUpdatedAt, now)) continue;
    // Only reports never attempted ask for another slice right away; retries wait for their backoff.
    if (attempted >= DISCORD_ANOMALY_REPORTS_PER_PASS) { if (!meeting.reportStatus) passMore(env); break; }
    if (!(meeting.reportStatus ? passFits(env, DISCORD_ANOMALY_REPORT_COST) : passAllows(env, DISCORD_ANOMALY_REPORT_COST))) break;
    attempted += 1;
    try { await sendDiscordAnomalyReport(env, config, settings.channelId, meeting, { late: settings.anomalyLateThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES, early: settings.anomalyEarlyThresholdMinutes ?? DEFAULT_ANOMALY_THRESHOLD_MINUTES }, settings.timeZone || "UTC"); } catch (error) { if (error instanceof SchedulerBudgetError) throw error; /* One failed report must not delay other eligible meetings. */ }
  }
}
/** While one pass is posting a tracked message, another that finds it missing waits this long before posting too. */
const DISCORD_TRACKED_MESSAGE_CLAIM_MS = 2 * 60_000;
