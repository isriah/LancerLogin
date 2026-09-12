export type Meeting={ id: string; title: string; startsAt: string; endsAt: string; required: boolean|number; isTest?: boolean|number; attendanceWeight?: number; weightCategoryName?: string|null; };
export type MeetingResponse={ meetings: Meeting[]; attendanceReportingStartsOn?: string|null; };
export type Row={ memberId: string; externalId: string; firstName: string; lastName: string; disposition: "present"|"active"|"absent"|"excused"|"not_required"; };
export type MemberStat={ memberId: string; externalId: string; firstName: string; lastName: string; present: number; primaryTotal: number; adjustedTotal: number; history: { meeting: Meeting; disposition: Row["disposition"]; }[]; };

export const percent=(top: number,bottom: number) => bottom? Math.round(top/bottom*100):0;

export const completedReportMeetings=(meetings: Meeting[],now=Date.now()) => meetings.filter((meeting) => !meeting.isTest&&Date.parse(meeting.endsAt)<=now).sort((left,right) => Date.parse(left.startsAt)-Date.parse(right.startsAt));
export const reportingPeriodMeetings=(meetings: Meeting[],from="",to="") => meetings.filter((meeting) => (!from||meeting.startsAt.slice(0,10)>=from)&&(!to||meeting.startsAt.slice(0,10)<=to));

export async function loadReportAttendance(request: <T>(path: string) => Promise<T>) {
  const result=await request<MeetingResponse>("/meetings");
  const meetings=completedReportMeetings(result.meetings);
  const results=await Promise.all(meetings.map(async (meeting) => [meeting.id,(await request<{ attendance: Row[]; }>(`/attendance?meetingId=${encodeURIComponent(meeting.id)}&includeInactive=1`)).attendance] as const));
  return { meetings,rows: Object.fromEntries(results),baseline: result.attendanceReportingStartsOn??"" };
}

export function calculateMemberStats(meetings: Meeting[],rows: Record<string,Row[]>) {
  const values=new Map<string,MemberStat>();
  for(const meeting of meetings) for(const row of rows[meeting.id]??[]) {
    const member=values.get(row.memberId)??{ memberId: row.memberId,externalId: row.externalId,firstName: row.firstName,lastName: row.lastName,present: 0,primaryTotal: 0,adjustedTotal: 0,history: [] };
    const weight=meeting.attendanceWeight??1;
    member.present+=row.disposition==="present"? weight:0;
    member.primaryTotal+=row.disposition==="not_required"? 0:weight;
    member.adjustedTotal+=row.disposition==="excused"||row.disposition==="not_required"? 0:weight;
    member.history.push({ meeting,disposition: row.disposition }); values.set(row.memberId,member);
  }
  return [...values.values()];
}

export function defaultRosterRates(data: Awaited<ReturnType<typeof loadReportAttendance>>) {
  const meetings=reportingPeriodMeetings(data.meetings,data.baseline);
  const stats=calculateMemberStats(meetings,data.rows);
  return { meetingCount: meetings.length,rates: Object.fromEntries(stats.map((member) => [member.memberId,{ rate: percent(member.present,member.primaryTotal),eligible: member.primaryTotal,complete: meetings.every((meeting) => data.rows[meeting.id]?.some((row) => row.memberId===member.memberId)) }])) };
}
