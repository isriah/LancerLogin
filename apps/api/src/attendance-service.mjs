import { requireCapability } from "../../../packages/shared/src/policy.mjs";
import { attendanceDisposition, nextAttendanceAction, scanWindowState } from "./attendance-lifecycle.ts";

const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export function createAttendanceService({ now = () => new Date().toISOString() } = {}) {
  const members = new Map();
  const meetings = new Map();
  const events = [];
  const corrections = new Map();
  const audit = [];
  const writeAudit = (principal, action, targetType, targetId) => audit.push({ actorUserId: principal.userId, action, targetType, targetId, createdAt: now() });

  return {
    addMember(principal, member) {
      requireCapability(principal, "manage-users");
      if (!member.id || !member.externalId || !member.firstName || !member.lastName) throw new Error("Invalid member");
      if ([...members.values()].some((existing) => existing.externalId === member.externalId)) throw new Error("Duplicate member ID");
      members.set(member.id, { ...member, active: true });
      writeAudit(principal, "member.created", "member", member.id);
    },
    createMeeting(principal, meeting) {
      requireCapability(principal, "manage-meetings");
      if (!meeting.id || !meeting.title || !meeting.startsAt || !meeting.endsAt) throw new Error("Invalid meeting");
      if (Date.parse(meeting.endsAt) <= Date.parse(meeting.startsAt)) throw new Error("Meeting ends before it starts");
      meetings.set(meeting.id, { ...meeting, required: meeting.required !== false });
      writeAudit(principal, "meeting.created", "meeting", meeting.id);
    },
    recordAttendance(principal, event) {
      requireCapability(principal, "manage-attendance");
      if (!members.get(event.memberId)?.active) throw new Error("Unknown active member");
      const meeting = meetings.get(event.meetingId); if (!meeting) throw new Error("Unknown meeting");
      if (events.some((existing) => existing.kioskEventId && existing.kioskEventId === event.kioskEventId)) return { duplicate: true };
      const occurredAt = event.occurredAt ?? now(); const window = scanWindowState(meeting, occurredAt, 30); if (!window.accepted) throw new Error(window.reason);
      const prior = events.filter((existing) => existing.memberId === event.memberId && existing.meetingId === event.meetingId);
      const transition = nextAttendanceAction(prior, occurredAt); if (transition.status === "complete") throw new Error("Attendance already complete"); if (transition.status === "duplicate") return { duplicate: true, action: transition.action };
      events.push({ ...event, source: event.source ?? "manual", occurredAt, action: transition.action });
      writeAudit(principal, "attendance.recorded", "member", event.memberId);
      return { duplicate: false, action: transition.action };
    },
    correctAttendance(principal, correction) {
      requireCapability(principal, correction.disposition === "excused" ? "manage-excuses" : "manage-corrections");
      const reason = correction.reason?.trim() ?? "";
      if (!members.has(correction.memberId) || !meetings.has(correction.meetingId) || (correction.disposition !== "present" && !reason)) throw new Error("Invalid correction");
      corrections.set(`${correction.memberId}:${correction.meetingId}`, { ...correction, reason, createdBy: principal.userId, createdAt: now() });
      writeAudit(principal, `attendance.${correction.disposition}`, "member", correction.memberId);
    },
    attendanceFor(meetingId) {
      return [...members.values()].filter((member) => member.active).map((member) => {
        const correction = corrections.get(`${member.id}:${meetingId}`);
        const memberEvents = events.filter((event) => event.memberId === member.id && event.meetingId === meetingId);
        return { member, disposition: attendanceDisposition(memberEvents, correction?.disposition), correction };
      });
    },
    exportCsv(principal) {
      requireCapability(principal, "view-reports");
      const rows = [["member_id", "member_name", "meeting_id", "meeting_title", "disposition"]];
      for (const meeting of meetings.values()) for (const row of this.attendanceFor(meeting.id)) rows.push([row.member.externalId, `${row.member.firstName} ${row.member.lastName}`, meeting.id, meeting.title, row.disposition]);
      writeAudit(principal, "attendance.exported", "attendance", "csv");
      return rows.map((row) => row.map(csv).join(",")).join("\n");
    },
    audit: () => [...audit],
  };
}
