import type { Meeting } from "./meeting-management";

export type MeetingForm = { title: string; date: string; endDate: string; startTime: string; endTime: string; required: boolean; notes: string; weightCategoryId?: string | null; audienceMode: "all" | "labels"; audienceLabelIds: string[]; startsAt?: string; endsAt?: string };
export const localInput = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
export const splitLocal = (value: string) => { const local = localInput(value); return { date: local.slice(0, 10), time: local.slice(11, 16) }; };
const savedTimestamp = (saved: string | undefined, date: string, time: string) => saved && splitLocal(saved).date === date && splitLocal(saved).time === time ? saved : new Date(`${date}T${time}`).toISOString();
export const meetingTimestamps = (value: MeetingForm) => ({ startsAt: savedTimestamp(value.startsAt, value.date, value.startTime), endsAt: savedTimestamp(value.endsAt, value.endDate, value.endTime) });
const endAfterMinutes = (date: string, time: string, minutes: number) => { const end = splitLocal(new Date(Date.parse(`${date}T${time}`) + minutes * 60_000).toISOString()); return { endDate: end.date, endTime: end.time }; };
export const addMinutes = (date: string, time: string, minutes: number) => endAfterMinutes(date, time || "00:00", minutes).endTime;
export const dateAfterDays = (date: string, days: number) => { const next = new Date(`${date}T12:00:00`); next.setDate(next.getDate() + days); return localInput(next.toISOString()).slice(0, 10); };
export const initialMeetingForm = (): MeetingForm => { const start = splitLocal(new Date(Date.now() + 3_600_000).toISOString()); return { title: "", date: start.date, startTime: start.time, ...endAfterMinutes(start.date, start.time, 150), required: true, notes: "", weightCategoryId: undefined, audienceMode: "all", audienceLabelIds: [] }; };
export function formForMeeting(meeting: Meeting, duplicate = false): MeetingForm {
  const start = splitLocal(meeting.startsAt); const end = splitLocal(meeting.endsAt);
  const common = { title: meeting.title, required: Boolean(meeting.required), notes: meeting.notes ?? "", audienceMode: meeting.audienceMode ?? "all", audienceLabelIds: meeting.audienceLabelIds ?? [] };
  if (!duplicate) return { ...common, date: start.date, endDate: end.date, startTime: start.time, endTime: end.time, startsAt: meeting.startsAt, endsAt: meeting.endsAt, weightCategoryId: meeting.weightCategoryId ?? null };
  const date = initialMeetingForm().date;
  return { ...common, date, startTime: start.time, ...endAfterMinutes(date, start.time, (Date.parse(meeting.endsAt) - Date.parse(meeting.startsAt)) / 60_000), weightCategoryId: undefined };
}
export const meetingDurationMinutes = (value: MeetingForm) => {
  if (!value.date || !value.endDate || !value.startTime || !value.endTime) return NaN;
  const timestamps = meetingTimestamps(value);
  return (Date.parse(timestamps.endsAt) - Date.parse(timestamps.startsAt)) / 60_000;
};
export function moveMeetingStart(value: MeetingForm, change: Partial<Pick<MeetingForm, "date" | "startTime">>, duration = meetingDurationMinutes(value)): MeetingForm {
  const next = { ...value, ...change };
  if (!next.date || !next.startTime || !Number.isFinite(duration) || duration <= 0) return next;
  const startsAt = new Date(`${next.date}T${next.startTime}`).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + duration * 60_000).toISOString();
  const end = splitLocal(endsAt);
  return { ...next, startsAt, endsAt, endDate: end.date, endTime: end.time };
}
