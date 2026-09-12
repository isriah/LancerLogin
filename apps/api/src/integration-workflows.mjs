export function createIntegrationWorkflows({ resend, discord, now = () => new Date().toISOString() }) {
  const deliveries = new Map();
  const contests = new Map();
  const calendarMappings = new Map();
  let kioskStatusMessage;
  return {
    async sendAbsenceEmail({ meetingId, member, force = false }) {
      const key = `absence:${meetingId}:${member.id}`;
      if (deliveries.has(key) && !force) return { sent: false, duplicate: true };
      await resend.send({ to: member.email, subject: `Attendance update: ${meetingId}`, text: "You were marked absent." });
      deliveries.set(key, { sentAt: now() }); return { sent: true, duplicate: false };
    },
    async sendMemberReport({ member, csv }) {
      await resend.send({ to: member.email, subject: "Your attendance report", text: csv });
      return { sent: true };
    },
    async notifyMissingMembers({ meetingId, members }) {
      const message = await discord.postMissing({ meetingId, memberIds: members.map((member) => member.discordUserId).filter(Boolean) });
      for (const member of members) if (member.discordUserId) contests.set(`${meetingId}:${member.id}`, { meetingId, memberId: member.id, status: "open", messageId: message.id });
      return message;
    },
    resolveContest({ meetingId, memberId, resolution }) {
      const contest = contests.get(`${meetingId}:${memberId}`); if (!contest) throw new Error("Contest not found");
      if (!["approved", "rejected", "reviewed"].includes(resolution)) throw new Error("Invalid resolution");
      contest.status = resolution; contest.resolvedAt = now(); return { ...contest };
    },
    async syncCalendar(meeting) {
      const existing = calendarMappings.get(meeting.id);
      const event = await discord.upsertCalendar({ eventId: existing?.eventId, meeting });
      calendarMappings.set(meeting.id, { eventId: event.id, syncedAt: now() }); return event;
    },
    async updateKioskStatus(status) {
      const rendered = `${status.name}: ${status.online ? "online" : "offline"}`;
      if (kioskStatusMessage?.rendered === rendered) return { changed: false, messageId: kioskStatusMessage.id };
      const message = await discord.upsertStatus({ messageId: kioskStatusMessage?.id, rendered });
      kioskStatusMessage = { id: message.id, rendered, updatedAt: now() }; return { changed: true, messageId: message.id };
    },
  };
}
