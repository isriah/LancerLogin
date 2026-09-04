import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { usePath } from "./router";

type Frequency = "daily" | "weekly" | "biweekly" | "monthly";
type Meeting = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  attendanceClosesAt: string;
  required: boolean | number;
  notes?: string | null;
  seriesId?: string | null;
  recurrenceFrequency?: Frequency | null;
  recurrenceUntil?: string | null;
  recurrenceSequence?: number | null;
};
type AttendanceRow = {
  memberId: string;
  externalId: string;
  firstName: string;
  lastName: string;
  discordUserId?: string;
  disposition: "present" | "active" | "absent" | "excused" | "not_required" | "upcoming";
  checkedInAt?: string;
  checkedOutAt?: string;
  reason?: string;
};
type Lifecycle = "upcoming" | "in_progress" | "late_scan_window" | "past";

const frequencyLabel = (value?: Frequency | null) => value === "biweekly" ? "Every two weeks" : value ? `${value[0].toUpperCase()}${value.slice(1)}` : "One time";
const lifecycleFor = (meeting: Meeting, now = Date.now()): Lifecycle => now < Date.parse(meeting.startsAt) ? "upcoming" : now <= Date.parse(meeting.endsAt) ? "in_progress" : now <= Date.parse(meeting.attendanceClosesAt) ? "late_scan_window" : "past";
const lifecycleLabel = (lifecycle: Lifecycle) => lifecycle === "in_progress" ? "In progress" : lifecycle === "late_scan_window" ? "Late scan window" : lifecycle[0].toUpperCase() + lifecycle.slice(1);

export function AttendanceWorkspace({ meetingId, role }: { meetingId: string; role: "admin" | "operator" }) {
  const { navigate } = usePath();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meeting, setMeeting] = useState<Meeting>();
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [notice, setNotice] = useState("Loading meeting…");
  const [memberNotices, setMemberNotices] = useState<Record<string, string>>({});
  const [clock, setClock] = useState(() => Date.now());
  const loadSequence = useRef(0);
  useDashboardLoadingOverlay(notice === "Loading meeting…", "Loading meeting…");

  async function attendanceFor(id = meetingId) { return api<{ attendance: AttendanceRow[] }>(`/attendance?meetingId=${encodeURIComponent(id)}`); }
  async function refreshAttendance(id = meetingId) { setRows((await attendanceFor(id)).attendance); }

  async function load(): Promise<boolean> {
    const sequence = ++loadSequence.current;
    const result = await api<{ meetings: Meeting[] }>("/meetings");
    if (sequence !== loadSequence.current) return false;
    const ordered = [...result.meetings].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
    setMeetings(ordered);
    setMemberNotices({});
    const requested = (await api<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(meetingId)}`)).meeting;
    const attendance = await attendanceFor(requested.id);
    if (sequence !== loadSequence.current) return false;
    setMeeting(requested);
    setRows(attendance.attendance);
    setClock(Date.now());
    setNotice("");
    return true;
  }

  useEffect(() => {
    setNotice("Loading meeting…");
    setMeeting(undefined);
    setRows([]);
    void load().catch((error: Error) => setNotice(error.message));
    return () => { loadSequence.current += 1; };
  }, [meetingId]);

  const lifecycle = useMemo(() => meeting ? lifecycleFor(meeting, clock) : undefined, [meeting, clock]);
  useEffect(() => {
    if (!meeting || !lifecycle) return;
    if (lifecycle === "in_progress" || lifecycle === "late_scan_window") {
      const timer = window.setInterval(() => {
        void refreshAttendance(meeting.id).catch((error: Error) => setNotice(error.message));
        setClock(Date.now());
      }, 30_000);
      const closesTimer = window.setTimeout(() => setClock(Date.now()), Math.max(0, Date.parse(meeting.attendanceClosesAt) - Date.now() + 1));
      return () => { window.clearInterval(timer); window.clearTimeout(closesTimer); };
    }
    if (lifecycle === "upcoming") {
      const opensTimer = window.setTimeout(() => setClock(Date.now()), Math.min(2_147_000_000, Math.max(0, Date.parse(meeting.startsAt) - Date.now() + 1)));
      return () => window.clearTimeout(opensTimer);
    }
  }, [meeting?.id, meeting?.startsAt, meeting?.attendanceClosesAt, lifecycle, clock]);

  function memberNotice(memberId: string, message: string) {
    setMemberNotices((current) => ({ ...current, [memberId]: message }));
    window.setTimeout(() => setMemberNotices((current) => { const next = { ...current }; delete next[memberId]; return next; }), 5000);
  }
  async function correct(row: AttendanceRow, disposition: "present" | "absent" | "excused") {
    if (row.disposition === "not_required") { memberNotice(row.memberId, "This member was not required for this meeting."); return; }
    const reason = window.prompt(disposition === "present" ? `Optional note for marking ${row.firstName} present:` : `Reason for marking ${row.firstName} ${disposition}:`);
    if (reason === null) return;
    if (disposition !== "present" && !reason.trim()) { memberNotice(row.memberId, "A reason is required for this change."); return; }
    try {
      await api("/attendance/corrections", { method: "POST", body: JSON.stringify({ memberId: row.memberId, meetingId, disposition, reason }) });
      await refreshAttendance();
      memberNotice(row.memberId, `Marked ${disposition}.`);
    } catch (error) { memberNotice(row.memberId, (error as Error).message); }
  }
  async function clear(row: AttendanceRow) {
    if (!window.confirm(`Clear all recorded attendance for ${row.firstName} ${row.lastName} in this meeting?`)) return;
    try {
      const result = await api<{ cleared: number }>("/attendance/cleanup", { method: "POST", body: JSON.stringify({ memberId: row.memberId, meetingId, confirmation: "CLEAR ATTENDANCE" }) });
      await refreshAttendance();
      memberNotice(row.memberId, result.cleared ? "Attendance records cleared." : "No attendance records needed clearing.");
    } catch (error) { memberNotice(row.memberId, (error as Error).message); }
  }
  async function manualRefresh() {
    setNotice("Refreshing attendance…");
    try { if (await load()) setNotice("Attendance refreshed."); }
    catch (error) { setNotice((error as Error).message); }
  }

  const recurrence = meeting?.recurrenceFrequency
    ? `${frequencyLabel(meeting.recurrenceFrequency)}${meeting.recurrenceSequence ? ` · Occurrence ${meeting.recurrenceSequence}` : ""}${meeting.recurrenceUntil ? ` · Through ${new Date(meeting.recurrenceUntil).toLocaleDateString()}` : ""}`
    : "One time";

  return <section className="attendance-workspace meeting-detail-workspace" aria-labelledby="meeting-detail-title">
    <div className="meeting-detail-navigation">
      <button type="button" onClick={() => navigate("/dashboard")}>Back to Dashboard</button>
      <label>Switch meeting<select value={meeting?.id ?? ""} onChange={(event) => { if (event.target.value) navigate(`/meetings/${encodeURIComponent(event.target.value)}`); }}><option value="">Choose a meeting</option>{meetings.map((item) => <option key={item.id} value={item.id}>{new Date(item.startsAt).toLocaleDateString()} · {item.title}</option>)}</select></label>
    </div>
    {meeting ? <>
      <header className="meeting-detail-heading"><div><span className={`meeting-lifecycle ${lifecycle}`}>{lifecycleLabel(lifecycle!)}</span><h1 id="meeting-detail-title">{meeting.title}</h1></div><button className="primary-button" type="button" onClick={() => void manualRefresh()}>Refresh attendance</button></header>
      <dl className="meeting-summary" aria-label="Meeting summary">
        <div><dt>Date</dt><dd>{new Date(meeting.startsAt).toLocaleDateString()}</dd></div>
        <div><dt>Time</dt><dd>{new Date(meeting.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–{new Date(meeting.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</dd></div>
        <div><dt>Attendance</dt><dd>{meeting.required ? "Required" : "Optional"}</dd></div>
        <div><dt>Recurrence</dt><dd>{recurrence}</dd></div>
        <div><dt>Attendance closes</dt><dd>{new Date(meeting.attendanceClosesAt).toLocaleString()}</dd></div>
        <div className="meeting-summary-notes"><dt>Notes</dt><dd>{meeting.notes || "No notes"}</dd></div>
      </dl>
      <div className="attendance-utilities"><span role="status" aria-live="polite">{notice}</span><span className="progress-count">{rows.filter((row) => row.disposition === "present").length} present</span></div>
      <section className="attendance-card" aria-labelledby="meeting-attendance-title"><div className="panel-heading"><h2 id="meeting-attendance-title">Attendance</h2></div>{rows.length ? <div className="attendance-table" role="table" aria-label="Meeting attendance"><div className="attendance-row header" role="row"><span>Member</span><span>Status</span><span>Actions</span></div>{rows.map((row) => <div className="attendance-row" role="row" key={row.memberId}><span><strong>{row.firstName} {row.lastName}</strong><small>{row.externalId}</small>{memberNotices[row.memberId] && <small className="member-action-notice" role="status">{memberNotices[row.memberId]}</small>}</span><span className={`attendance-state ${row.disposition}`}>{row.disposition === "not_required" ? "Not required" : row.disposition}</span><span className="correction-actions"><button type="button" disabled={row.disposition === "present"} onClick={() => void correct(row, "present")}>Present</button><button type="button" disabled={row.disposition === "excused"} onClick={() => void correct(row, "excused")}>Excuse</button><button type="button" disabled={row.disposition === "absent"} onClick={() => void correct(row, "absent")}>Absent</button>{role === "admin" && <button type="button" disabled={row.disposition === "not_required"} onClick={() => void clear(row)}>Clear</button>}</span></div>)}</div> : <p className="empty-state">No active roster records are available.</p>}</section>
    </> : <section className="empty-page"><h1 id="meeting-detail-title">Meeting unavailable</h1><p role="status">{notice}</p><p>The meeting may have been removed, or the link may be incorrect. Choose another meeting or return to Dashboard.</p></section>}
  </section>;
}
