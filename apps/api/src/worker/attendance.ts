import { inactiveAt } from "../member-participation.ts";
import { checkScanPin } from "../member-pins.ts";
import { discordCodeAcceptance, findDiscordKioskCode, type DiscordCodeLookup } from "../discord-kiosk-codes.ts";
import { attendanceClosesAt, attendanceDisposition, nextAttendanceAction, scanMeetingFor, scanWindowState, type AttendanceAction } from "../attendance-lifecycle.ts";
import { alreadyDoneRefusal, notStartedYetRefusal, scanWindowRefusal } from "../scan-refusal.ts";
import { meetingEligibility, localDate as policyLocalDate, participationStartDate, type AttendanceRule, type LabelChange } from "../attendance-policy.ts";
import { type D1Database, type D1Statement } from "../d1-usage.ts";
import { HttpError } from "../http-error.ts";
import { recordScanMatch } from "../fingerprint-match.ts";
import { acceptedScanStatements, findImpossibleScan, recordPossibleWrongMatch } from "../scan-integrity.ts";
import { type Env, parseJson, requireDatabase, requireRole, response, validTimestamp, writeAudit } from "./core.ts";
import { kioskFor } from "./kiosks.ts";
import { meetingAudienceIds } from "./meeting-audience.ts";
import { scanAllowances } from "./meetings.ts";

// discordCode: the scan named its member with a Discord code, which is used up only by the batch that records the scan.
type KioskScanOrigin = { kioskId: string; refuseWrongMatches: boolean; matchScore?: unknown; discordCode?: Omit<DiscordCodeLookup, "memberId"> };
async function recordAttendance(db: D1Database, input: { eventId?: string; memberId?: string; meetingId?: string; occurredAt?: string; desiredAction?: AttendanceAction }, source: "kiosk" | "manual", actorId?: string, origin?: KioskScanOrigin): Promise<Response> {
  if (!input.eventId?.trim() || input.eventId.length > 100 || !input.memberId || !validTimestamp(input.occurredAt)) throw new HttpError(400, "eventId, memberId, and a valid occurredAt timestamp are required", undefined, "invalid_scan");
  const existing = await db.prepare("SELECT action FROM attendance_events WHERE installation_id = 'primary' AND kiosk_event_id = ?").bind(input.eventId.trim()).first<{ action: AttendanceAction }>();
  if (existing) return response({ accepted: false, duplicate: true, eventId: input.eventId, action: existing.action }, 200);
  const [member, settings] = await Promise.all([
    db.prepare("SELECT id, external_id AS externalId, first_name AS firstName, last_name AS lastName, attendance_required_from AS attendanceRequiredFrom, created_at AS rosterAddedAt FROM members WHERE installation_id = 'primary' AND (id = ? OR external_id = ?) AND active = 1").bind(input.memberId, input.memberId).first<{ id: string; externalId: string; firstName: string; lastName: string; attendanceRequiredFrom?: string | null; rosterAddedAt?: string | null }>(),
    scanAllowances(db),
  ]);
  const allowances = settings;
  // Without a chosen meeting, one read returns the latest meeting that started by the scan and the next one to start, whose
  // early arrival window may hold the scan; scanMeetingFor picks between them.
  type ScanMeeting = { id: string; title: string; startsAt: string; endsAt: string };
  // A scan with a chosen meeting reads that meeting only, so it has no candidates and its refusals carry no window reason.
  const candidates = input.meetingId ? undefined : (await db.prepare("SELECT id, title, startsAt, endsAt FROM (SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL AND starts_at <= ? ORDER BY starts_at DESC LIMIT 1) UNION ALL SELECT id, title, startsAt, endsAt FROM (SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND deleted_at IS NULL AND starts_at > ? ORDER BY starts_at LIMIT 1)").bind(input.occurredAt, input.occurredAt).all<ScanMeeting>()).results ?? [];
  const meeting = candidates
    ? scanMeetingFor(candidates, input.occurredAt, allowances.lateScanMinutes, allowances.earlyScanMinutes)
    : await db.prepare("SELECT id, title, starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(input.meetingId).first<ScanMeeting>();
  // Why no meeting takes the scan, from the meetings already read: no further query.
  const windowRefusal = () => candidates ? scanWindowRefusal(candidates, input.occurredAt!, settings.timeZone, allowances.lateScanMinutes, allowances.earlyScanMinutes) : undefined;
  if (!member) throw new HttpError(404, "This identity is not linked to an active roster member", undefined, "roster_inactive");
  if (!meeting) throw new HttpError(409, "No meeting is accepting attendance scans at this time", undefined, "no_eligible_meeting", windowRefusal());
  const participationStartsOn = participationStartDate(member, settings.timeZone);
  if (participationStartsOn && policyLocalDate(meeting.startsAt, settings.timeZone) < participationStartsOn) throw new HttpError(409, `Attendance for ${member.firstName} begins on ${participationStartsOn}`, undefined, "participation_not_started", notStartedYetRefusal(participationStartsOn));
  const window = scanWindowState(meeting, input.occurredAt, allowances.lateScanMinutes, allowances.earlyScanMinutes);
  if (!window.accepted) throw new HttpError(409, input.meetingId ? window.reason : "No meeting is accepting attendance scans at this time", undefined, input.meetingId ? "scan_window_closed" : "no_eligible_meeting", windowRefusal());
  const occurredAt = new Date(input.occurredAt).toISOString();
  const [prior, conflict] = await Promise.all([
    db.prepare("SELECT id, action, occurred_at AS occurredAt FROM attendance_events WHERE installation_id = 'primary' AND member_id = ? AND meeting_id = ? ORDER BY occurred_at, id").bind(member.id, meeting.id).all<{ id: string; action: AttendanceAction; occurredAt: string }>(),
    origin?.refuseWrongMatches ? findImpossibleScan(db, origin.kioskId, member.id, occurredAt) : Promise.resolve(null),
  ]);
  // Same-kiosk repeats keep the duplicate handling below; only another kiosk's accepted scan makes this one impossible.
  if (origin && conflict) {
    await recordPossibleWrongMatch(db, { eventId: input.eventId.trim(), kioskId: origin.kioskId, memberId: member.id, occurredAt, matchScore: origin.matchScore }, conflict);
    throw new HttpError(409, "Scan again", undefined, "possible_wrong_match");
  }
  const priorEvents = prior.results ?? [];
  const transition = input.desiredAction
    ? priorEvents.some((event) => event.action === input.desiredAction) ? { status: "duplicate" as const, action: input.desiredAction } : input.desiredAction === "check_out" && !priorEvents.some((event) => event.action === "check_in") ? { status: "complete" as const } : { status: "accepted" as const, action: input.desiredAction }
    : nextAttendanceAction(priorEvents, input.occurredAt);
  if (transition.status === "duplicate") return response({ accepted: false, duplicate: true, eventId: input.eventId, action: transition.action, attendanceClosesAt: window.closesAt }, 200);
  if (transition.status === "complete") throw new HttpError(409, "Attendance is already complete for this member and meeting", undefined, "attendance_complete", priorEvents.some((event) => event.action === "check_in") && priorEvents.some((event) => event.action === "check_out") ? alreadyDoneRefusal() : undefined);
  const id = crypto.randomUUID();
  // A Discord code scan is recorded only while its code is still good, and uses the code up in the same batch: every
  // refusal above, and a failure here, leaves the code for another try. If another scan used it first, this one is refused.
  const code = origin?.discordCode ? discordCodeAcceptance(db, { ...origin.discordCode, kioskId: origin.kioskId, memberId: member.id, eventId: input.eventId.trim() }) : undefined;
  const insert = db.prepare(`INSERT OR IGNORE INTO attendance_events (id, installation_id, member_id, meeting_id, source, occurred_at, kiosk_event_id, created_by, action) ${code ? `SELECT ?, 'primary', ?, ?, ?, ?, ?, ?, ? WHERE ${code.live}` : "VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, ?)"}`).bind(id, member.id, meeting.id, source, input.occurredAt, input.eventId.trim(), actorId ?? null, transition.action, ...(code?.liveValues ?? []));
  // Kiosk scans also remember their kiosk, in the same round trip, so a scan on another kiosk can be checked against them.
  // A schema before 0088 lacks the table; the scan is then recorded alone, as before. (Discord codes need a later schema.)
  const accepted = origin ? acceptedScanStatements(db, { eventId: input.eventId.trim(), kioskId: origin.kioskId, memberId: member.id, occurredAt }) : [];
  let result: Awaited<ReturnType<D1Statement["run"]>>;
  if (code) {
    const results = await db.batch([insert, ...code.statements, ...accepted]); result = results[0]!;
    const refusal = (result.meta?.changes ?? 1) > 0 ? undefined : code.refused(results.slice(1, 1 + code.statements.length));
    if (refusal) throw refusal;
  } else result = origin ? await db.batch([insert, ...accepted]).then(results => results[0]!, () => insert.run()) : await insert.run();
  return response({ accepted: (result.meta?.changes ?? 1) > 0, duplicate: (result.meta?.changes ?? 1) === 0, eventId: input.eventId, action: transition.action, attendanceClosesAt: window.closesAt, meeting: { id: meeting.id, title: meeting.title }, member: { id: member.id, externalId: member.externalId, displayName: `${member.firstName} ${member.lastName}`.trim() } }, 202);
}
export async function kioskAttendance(request: Request, env: Env): Promise<Response> {
  const kiosk = await kioskFor(request, env); const input = await parseJson<{ eventId?: string; memberId?: string; meetingId?: string; occurredAt?: string; desiredAction?: AttendanceAction; pairingId?: string; matchScore?: unknown; rescanSupported?: unknown; pin?: unknown; pinCheck?: unknown; discordCode?: unknown }>(request);
  if ((kiosk.pairingBound || input.pairingId !== undefined) && input.pairingId !== kiosk.pairingId) throw new HttpError(409, "This queued scan belongs to a different kiosk pairing and was not attached to the current kiosk", undefined, "pairing_mismatch");
  const db = requireDatabase(env); let discordCode: Omit<DiscordCodeLookup, "memberId"> | undefined;
  // A kiosk with Require PIN checks the member's PIN before the scan is recorded; other kiosks ignore pin and pinCheck.
  // A malformed scan skips the check and fails below with its usual reason.
  // A scan with discordCode names no member: the code, from /code in Discord, does. It is looked up here, online, whatever
  // pin or pinCheck say, and never needs a PIN: Require PIN covers the kiosk's member ID method only. Only the scan being
  // recorded uses the code up (recordAttendance).
  if (input.discordCode !== undefined && input.discordCode !== null) {
    if (input.memberId !== undefined && input.memberId !== null) throw new HttpError(400, "Send a member ID or a Discord code, not both", undefined, "invalid_scan");
    // A malformed scan fails before the code is looked up.
    if (!input.eventId?.trim() || input.eventId.length > 100 || !validTimestamp(input.occurredAt)) throw new HttpError(400, "eventId, a Discord code, and a valid occurredAt timestamp are required", undefined, "invalid_scan");
    const found = await findDiscordKioskCode(db, kiosk, { discordCode: input.discordCode, eventId: input.eventId.trim() });
    if ("duplicate" in found) return response({ accepted: false, duplicate: true, eventId: input.eventId, action: found.duplicate }, 200);
    const { memberId, ...lookup } = found; input.memberId = memberId; discordCode = lookup;
  }
  else if (kiosk.requirePin && input.eventId?.trim() && input.eventId.length <= 100 && input.memberId && validTimestamp(input.occurredAt)) await checkScanPin(db, kiosk, input);
  // Recorded whatever the outcome, so rejected scans show their match confidence too. Diagnostics never block attendance.
  if (input.matchScore !== undefined) await recordScanMatch(db, kiosk.id, input.eventId, input.matchScore).catch(() => undefined);
  // Only kiosks that can ask for a rescan are refused a possible wrong match. Older kiosks retry an unknown refusal
  // forever, holding up every scan queued behind it, so their scans are recorded as before.
  return recordAttendance(db, input, "kiosk", undefined, { kioskId: kiosk.id, refuseWrongMatches: input.rescanSupported === true, matchScore: input.matchScore, ...(discordCode ? { discordCode } : {}) });
}
export async function attendance(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env); const url = new URL(request.url);
  if (request.method === "GET") {
    const meetingId = url.searchParams.get("meetingId"); const includeInactive = url.searchParams.get("includeInactive") === "1"; if (!meetingId) throw new HttpError(400, "meetingId is required");
    const [rows, meeting, settings, audiences, labelResult, changeResult, targetResult] = await Promise.all([
      db.prepare("SELECT m.id AS memberId, m.external_id AS externalId, m.first_name AS firstName, m.last_name AS lastName, m.discord_user_id AS discordUserId, m.attendance_required_from AS attendanceRequiredFrom, m.inactive_periods_json AS inactivePeriodsJson, m.created_at AS rosterAddedAt, (SELECT c.disposition FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS correction, (SELECT c.reason FROM attendance_corrections c WHERE c.member_id = m.id AND c.meeting_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS reason, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_in') AS checkedInAt, (SELECT MIN(e.occurred_at) FROM attendance_events e WHERE e.member_id = m.id AND e.meeting_id = ? AND e.action = 'check_out') AS checkedOutAt FROM members m WHERE m.installation_id = 'primary' AND (m.active = 1 OR ? = 1) ORDER BY m.last_name, m.first_name").bind(meetingId, meetingId, meetingId, meetingId, includeInactive ? 1 : 0).all<{ memberId: string; externalId: string; firstName: string; lastName: string; discordUserId?: string; attendanceRequiredFrom?: string; inactivePeriodsJson?: string; rosterAddedAt?: string; correction?: "present" | "absent" | "excused"; reason?: string; checkedInAt?: string; checkedOutAt?: string }>(),
      db.prepare("SELECT starts_at AS startsAt, ends_at AS endsAt, required, audience_mode AS audienceMode FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL").bind(meetingId).first<{ startsAt: string; endsAt: string; required: number; audienceMode: "all" | "labels" }>(),
      db.prepare("SELECT late_scan_minutes AS lateScanMinutes, time_zone AS timeZone, attendance_policy_activated_on AS policyActivatedOn FROM organization_settings WHERE installation_id = 'primary'").first<{ lateScanMinutes: number; timeZone: string; policyActivatedOn: string | null }>(),
      meetingAudienceIds(db, [meetingId]),
      db.prepare("SELECT id, name, formula_enabled AS formulaEnabled FROM member_labels WHERE installation_id = 'primary'").all<{ id: string; name: string; formulaEnabled: number }>(),
      db.prepare("SELECT member_id AS memberId, label_id AS labelId, action, effective_date AS effectiveDate FROM member_label_changes WHERE installation_id = 'primary' ORDER BY effective_date, created_at, id").all<LabelChange>(),
      db.prepare("SELECT id, label_id AS labelId, starts_on AS startsOn, ends_on AS endsOn, rule_type AS ruleType FROM label_attendance_rules WHERE installation_id = 'primary'").all<Pick<AttendanceRule, "id" | "labelId" | "startsOn" | "endsOn" | "ruleType">>(),
    ]);
    if (!meeting) throw new HttpError(404, "Meeting not found");
    const closesAt = attendanceClosesAt(meeting.endsAt, settings?.lateScanMinutes ?? 30); const finalized = Date.now() > Date.parse(closesAt);
    const meetingDate = policyLocalDate(meeting.startsAt, settings?.timeZone ?? "UTC"); const audienceIds = audiences.get(meetingId) ?? []; const labelsById = new Map((labelResult.results ?? []).map((label) => [label.id, label]));
    const audience = meeting.audienceMode === "all" ? "All" : audienceIds.map((id) => labelsById.get(id)?.name ?? "Retired label").join(", ");
    return response({ attendance: (rows.results ?? []).map((row) => {
      const events = [{ action: "check_in" as const, occurredAt: row.checkedInAt }, ...(row.checkedOutAt ? [{ action: "check_out" as const, occurredAt: row.checkedOutAt }] : [])].filter((event) => event.occurredAt); const derived = attendanceDisposition(events, row.correction);
      const activeLabels = new Set<string>(); for (const change of changeResult.results ?? []) if (change.memberId === row.memberId && change.effectiveDate <= meetingDate) { if (change.action === "add") activeLabels.add(change.labelId); else activeLabels.delete(change.labelId); }
      const policyLabel = [...activeLabels].find((id) => (targetResult.results ?? []).some((rule) => rule.labelId === id)) ?? (settings?.policyActivatedOn && meetingDate < settings.policyActivatedOn ? [...activeLabels].find((id) => labelsById.get(id)?.formulaEnabled) : undefined);
      const selected = (targetResult.results ?? []).find((rule) => rule.labelId === policyLabel && rule.startsOn && rule.startsOn <= meetingDate && (!rule.endsOn || meetingDate <= rule.endsOn)) ?? (targetResult.results ?? []).find((rule) => rule.labelId === policyLabel && !rule.startsOn);
      const weekly = selected?.ruleType === "weekly_count";
      const legacy = Boolean(selected?.id.startsWith("legacy:") && settings?.policyActivatedOn && meetingDate < settings.policyActivatedOn);
      const eligibility = meetingEligibility({ date: meetingDate, participationStart: participationStartDate(row, settings?.timeZone ?? "UTC"), activeLabels: legacy && policyLabel ? new Set([policyLabel]) : activeLabels, formulaLabel: weekly || !selected ? policyLabel : undefined, hasWeeklyTarget: weekly, meeting: { required: meeting.required, audienceMode: meeting.audienceMode ?? "all", audienceLabelIds: audienceIds } });
      const { inactivePeriodsJson, ...visibleRow } = row;
      if (inactiveAt(inactivePeriodsJson, meeting.startsAt)) return { ...visibleRow, disposition: "not_required", eligibility: "inactive", rateEligible: false, policy: weekly ? "weekly" : "standard", audience };
      return { ...visibleRow, disposition: Date.now() < Date.parse(meeting.startsAt) && derived === "absent" ? "upcoming" : finalized && derived === "active" ? "absent" : derived, eligibility, rateEligible: eligibility === "required" || eligibility === "weekly", policy: weekly ? "weekly" : "standard", audience };
    }), audience, attendanceClosesAt: closesAt, finalized });
  }
  return recordAttendance(db, await parseJson(request), "manual", principal.userId);
}
export async function correction(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin", "operator"]); const db = requireDatabase(env);
  const input = await parseJson<{ memberId?: string; meetingId?: string; disposition?: "present" | "absent" | "excused"; reason?: string }>(request);
  const reason = input.reason?.trim() ?? "";
  if (!input.memberId || !input.meetingId || !input.disposition || !["present", "absent", "excused"].includes(input.disposition) || (input.disposition !== "present" && !reason) || reason.length > 300) throw new HttpError(400, "Member, meeting, disposition, and a reason are required for absence or excuse corrections");
  const target = await db.prepare("SELECT EXISTS (SELECT 1 FROM members WHERE installation_id = 'primary' AND id = ?1) AS member, (SELECT deleted_at IS NULL FROM meetings WHERE installation_id = 'primary' AND id = ?2) AS meetingActive")
    .bind(input.memberId, input.meetingId).first<{ member: number; meetingActive: number | null }>();
  if (!target?.member) throw new HttpError(404, "Member not found");
  if (target.meetingActive === null || target.meetingActive === undefined) throw new HttpError(404, "Meeting not found");
  const deletedMeeting = new HttpError(409, "This meeting was deleted. Restore it before correcting its attendance.");
  if (!target.meetingActive) throw deletedMeeting;
  // The insert re-checks the meeting, so one deleted after the check above is still refused; the audit row follows the correction.
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const [inserted] = await db.batch([
    db.prepare("INSERT INTO attendance_corrections (id, installation_id, member_id, meeting_id, disposition, reason, created_by, created_at) SELECT ?, 'primary', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM meetings WHERE installation_id = 'primary' AND id = ? AND deleted_at IS NULL)").bind(id, input.memberId, input.meetingId, input.disposition, reason, principal.userId, now, input.meetingId),
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) SELECT ?, 'primary', ?, 'attendance.corrected', 'attendance_correction', ?, ?, ? WHERE EXISTS (SELECT 1 FROM attendance_corrections WHERE id = ?)").bind(crypto.randomUUID(), principal.userId, id, JSON.stringify({ memberId: input.memberId, meetingId: input.meetingId, disposition: input.disposition }), now, id),
  ]);
  if (!inserted?.meta?.changes) throw deletedMeeting;
  return response({ correction: { id, ...input, reason, createdAt: now } }, 201);
}
export async function cleanupAttendance(request: Request, env: Env): Promise<Response> {
  const principal = await requireRole(request, env, ["admin"]); const db = requireDatabase(env);
  const input = await parseJson<{ memberId?: string; meetingId?: string; confirmation?: string }>(request);
  if (!input.memberId || !input.meetingId) throw new HttpError(400, "Member and meeting are required");
  if (input.confirmation !== "CLEAR ATTENDANCE") throw new HttpError(400, "Type CLEAR ATTENDANCE exactly to continue");
  const member = await db.prepare("SELECT id FROM members WHERE installation_id = 'primary' AND id = ?").bind(input.memberId).first<{ id: string }>();
  const meeting = await db.prepare("SELECT id FROM meetings WHERE installation_id = 'primary' AND id = ?").bind(input.meetingId).first<{ id: string }>();
  if (!member || !meeting) throw new HttpError(404, "Member or meeting not found");
  const results = await db.batch([db.prepare("DELETE FROM attendance_events WHERE installation_id = 'primary' AND member_id = ? AND meeting_id = ? RETURNING id").bind(member.id, meeting.id), db.prepare("DELETE FROM attendance_corrections WHERE installation_id = 'primary' AND member_id = ? AND meeting_id = ? RETURNING id").bind(member.id, meeting.id)]);
  const cleared = (results[0]?.results?.length ?? 0) + (results[1]?.results?.length ?? 0); await writeAudit(db, principal, "attendance.member_meeting_cleared", "meeting", meeting.id, { memberId: member.id, cleared }); return response({ cleared });
}
