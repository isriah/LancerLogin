import { requireCapability } from "../../../packages/shared/src/policy.mjs";

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
      if (!meeting.id || !meeting.title || !meeting.startsAt) throw new Error("Invalid meeting");
      if (meeting.endsAt && Date.parse(meeting.endsAt) < Date.parse(meeting.startsAt)) throw new Error("Meeting ends before it starts");
      meetings.set(meeting.id, { ...meeting, required: meeting.required !== false });
      writeAudit(principal, "meeting.created", "meeting", meeting.id);
    },
    recordAttendance(principal, event) {
      requireCapability(principal, "manage-attendance");
      if (!members.get(event.memberId)?.active) throw new Error("Unknown active member");
      if (!meetings.has(event.meetingId)) throw new Error("Unknown meeting");
      if (events.some((existing) => existing.kioskEventId && existing.kioskEventId === event.kioskEventId)) return { duplicate: true };
      events.push({ ...event, source: event.source ?? "manual", occurredAt: event.occurredAt ?? now() });
      writeAudit(principal, "attendance.recorded", "member", event.memberId);
      return { duplicate: false };
    },
    correctAttendance(principal, correction) {
      requireCapability(principal, correction.disposition === "excused" ? "manage-excuses" : "manage-corrections");
      if (!members.has(correction.memberId) || !meetings.has(correction.meetingId) || !correction.reason?.trim()) throw new Error("Invalid correction");
      corrections.set(`${correction.memberId}:${correction.meetingId}`, { ...correction, createdBy: principal.userId, createdAt: now() });
      writeAudit(principal, `attendance.${correction.disposition}`, "member", correction.memberId);
    },
    attendanceFor(meetingId) {
      return [...members.values()].filter((member) => member.active).map((member) => {
        const correction = corrections.get(`${member.id}:${meetingId}`);
        const present = events.some((event) => event.memberId === member.id && event.meetingId === meetingId);
        return { member, disposition: correction?.disposition ?? (present ? "present" : "absent"), correction };
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
