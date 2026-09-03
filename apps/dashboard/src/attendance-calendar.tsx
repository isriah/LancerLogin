import { useMemo } from "react";

export type CalendarMeeting = { id: string; title: string; startsAt: string };
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function AttendanceCalendar({ meetings, onSelect }: { meetings: CalendarMeeting[]; onSelect: (meeting: CalendarMeeting) => void }) {
  const days = useMemo(() => { const sunday = new Date(); sunday.setHours(0, 0, 0, 0); sunday.setDate(sunday.getDate() - sunday.getDay() - 7); return Array.from({ length: 35 }, (_, index) => { const day = new Date(sunday); day.setDate(sunday.getDate() + index); return day; }); }, []);
  const events = useMemo(() => new Map(days.map((day) => [dayKey(day), meetings.filter((meeting) => dayKey(new Date(meeting.startsAt)) === dayKey(day)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))])), [days, meetings]);
  return <section className="rolling-calendar attendance-calendar" aria-labelledby="attendance-calendar-title"><div className="section-heading"><div><h2 id="attendance-calendar-title">Meeting calendar</h2><p>Choose a past or current meeting for attendance. Future meetings open their setup.</p></div></div><div className="calendar-weekdays" aria-hidden="true">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{days.map((day) => { const items = events.get(dayKey(day)) ?? []; return <article key={dayKey(day)} className="calendar-day"><header><span>{day.toLocaleDateString(undefined, { month: "short" })}</span><strong>{day.getDate()}</strong></header>{items.map((meeting) => <button key={meeting.id} type="button" onClick={() => onSelect(meeting)}><span>{new Date(meeting.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>{meeting.title}</button>)}</article>; })}</div></section>;
}
