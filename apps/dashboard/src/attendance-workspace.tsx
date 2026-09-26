import { visiblePoll } from "./visible-poll";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { ContestReviewList, type Contest } from "./contest-review-list";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { MeetingDeleteDialog, MeetingDuplicateDialog, MeetingEditDialog, pendingMeetingDeletionKey, type Meeting, type PendingMeetingDeletion } from "./meeting-management";
import { RouteLink, usePath } from "./router";
import { InfoHeading } from "./info-tip";

type Frequency = NonNullable<Meeting["recurrenceFrequency"]>;
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
  eligibility?: string;
  policy?: string;
  rateEligible?: boolean;
};
type Lifecycle = "upcoming" | "in_progress" | "late_scan_window" | "past";
type CalendarProviderResult = { provider: "google_calendar" | "discord"; synced: number; queued: number; skipped?: number; failed: number };

const frequencyLabel = (value?: Frequency | null) => value === "biweekly" ? "Every two weeks" : value ? `${value[0].toUpperCase()}${value.slice(1)}` : "One time";
const lifecycleFor = (meeting: Meeting, now = Date.now()): Lifecycle => now < Date.parse(meeting.startsAt) ? "upcoming" : now <= Date.parse(meeting.endsAt) ? "in_progress" : now <= Date.parse(meeting.attendanceClosesAt) ? "late_scan_window" : "past";
const lifecycleLabel = (lifecycle: Lifecycle) => lifecycle === "in_progress" ? "In progress" : lifecycle === "late_scan_window" ? "Late scan window" : lifecycle[0].toUpperCase() + lifecycle.slice(1);
const formatScanTime = (value?: string) => value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Not recorded";

export function AttendanceWorkspace({ meetingId, role }: { meetingId: string; role: "admin" | "operator" }) {
  const { path, navigate } = usePath();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meeting, setMeeting] = useState<Meeting>();
  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [audience, setAudience] = useState("All");
  const [contests, setContests] = useState<Contest[]>([]);
  const [discordConfigured, setDiscordConfigured] = useState(false);
  const [calendarProviders, setCalendarProviders] = useState<Array<"google_calendar" | "discord">>([]);
  const [calendarNotice, setCalendarNotice] = useState("");
  const [calendarNoticeTone, setCalendarNoticeTone] = useState<"neutral" | "success" | "error">("neutral");
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [discordNotice, setDiscordNotice] = useState("");
  const [discordNoticeTone, setDiscordNoticeTone] = useState<"neutral" | "success" | "error">("neutral");
  const [discordBusy, setDiscordBusy] = useState<"calendar" | "absence">();
  const [notice, setNotice] = useState("Loading meeting…");
  const [memberNotices, setMemberNotices] = useState<Record<string, string>>({});
  const [managementAction, setManagementAction] = useState<"edit" | "duplicate" | "delete">();
  const [clock, setClock] = useState(() => Date.now());
  const loadSequence = useRef(0);
  useDashboardLoadingOverlay(notice === "Loading meeting…", "Loading meeting…");

  async function attendanceFor(id = meetingId) { return api<{ attendance: AttendanceRow[]; audience: string }>(`/attendance?meetingId=${encodeURIComponent(id)}`); }
  async function refreshAttendance(id = meetingId) { const result = await attendanceFor(id); setRows(result.attendance); setAudience(result.audience ?? "All"); }

  async function load(): Promise<boolean> {
    const sequence = ++loadSequence.current;
    const [result, capabilities] = await Promise.all([
      api<{ meetings: Meeting[] }>("/meetings"),
      api<{ integrations: { discord: { configured: boolean }; google_calendar: { configured: boolean } } }>("/integrations/capabilities").catch(() => ({ integrations: { discord: { configured: false }, google_calendar: { configured: false } } })),
    ]);
    if (sequence !== loadSequence.current) return false;
    const discordAvailable = capabilities.integrations.discord.configured;
    const ordered = [...result.meetings].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
    setMeetings(ordered);
    setMemberNotices({});
    const requested = (await api<{ meeting: Meeting }>(`/meetings/${encodeURIComponent(meetingId)}`)).meeting;
    const [attendance, contestResult] = await Promise.all([
      attendanceFor(requested.id),
      discordAvailable ? api<{ contests: Contest[] }>(`/discord/contests?meetingId=${encodeURIComponent(requested.id)}`) : Promise.resolve({ contests: [] }),
    ]);
    if (sequence !== loadSequence.current) return false;
    setMeeting(requested);
    setRows(attendance.attendance);
    setAudience(attendance.audience ?? "All");
    setContests(contestResult.contests.filter((contest) => contest.status === "open"));
    setDiscordConfigured(discordAvailable);
    setCalendarProviders([...(capabilities.integrations.google_calendar?.configured ? ["google_calendar" as const] : []), ...(discordAvailable ? ["discord" as const] : [])]);
    setCalendarNotice("");
    setDiscordNotice("");
    setClock(Date.now());
    setNotice("");
    return true;
  }

  useEffect(() => {
    setNotice("Loading meeting…");
    setMeeting(undefined);
    setRows([]);
    setContests([]);
    setDiscordNotice("");
    void load().catch((error: Error) => setNotice(error.message));
    return () => { loadSequence.current += 1; };
  }, [meetingId]);

  const lifecycle = useMemo(() => meeting ? lifecycleFor(meeting, clock) : undefined, [meeting, clock]);
  useEffect(() => {
    if (!meeting || !lifecycle) return;
    if (lifecycle === "in_progress" || lifecycle === "late_scan_window") {
      const stop = visiblePoll(async () => {
        await refreshAttendance(meeting.id);
        setClock(Date.now());
      }, 30_000, (error) => setNotice(error.message));
      const endsTimer = window.setTimeout(() => setClock(Date.now()), Math.max(0, Date.parse(meeting.endsAt) - Date.now() + 1));
      const closesTimer = window.setTimeout(() => setClock(Date.now()), Math.max(0, Date.parse(meeting.attendanceClosesAt) - Date.now() + 1));
      return () => { stop(); window.clearTimeout(endsTimer); window.clearTimeout(closesTimer); };
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
  async function syncCalendars() {
    if (!meeting) return;
    setCalendarBusy(true); setCalendarNotice("Syncing this meeting to configured calendars…"); setCalendarNoticeTone("neutral");
    try {
      const result = await api<{ providers: CalendarProviderResult[] }>("/calendars/sync", { method: "POST", body: JSON.stringify({ meetingId: meeting.id }) });
      const labels = result.providers.map((provider) => `${provider.provider === "google_calendar" ? "Google Calendar" : "Discord"}: ${provider.synced} updated${provider.queued ? `, ${provider.queued} queued` : ""}${provider.skipped ? `, ${provider.skipped} skipped` : ""}${provider.failed ? `, ${provider.failed} need attention` : ""}`);
      setCalendarNotice(labels.join(" · ")); setCalendarNoticeTone(result.providers.some((provider) => provider.failed) ? "error" : "success");
    } catch (error) { setCalendarNotice((error as Error).message); setCalendarNoticeTone("error"); }
    finally { setCalendarBusy(false); }
  }
  async function notifyDiscordAbsences() {
    if (!meeting) return;
    setDiscordBusy("absence"); setDiscordNotice("Sending the Discord absence notice…"); setDiscordNoticeTone("neutral");
    try {
      const result = await api<{ posted: boolean; linkedMissingCount: number }>("/discord/missing", { method: "POST", body: JSON.stringify({ meetingId: meeting.id }) });
      setDiscordNotice(result.posted ? `Discord absence notice sent to ${result.linkedMissingCount} linked member${result.linkedMissingCount === 1 ? "" : "s"}.` : "No linked absent members need a Discord notice."); setDiscordNoticeTone("success");
    } catch (error) { setDiscordNotice((error as Error).message); setDiscordNoticeTone("error"); }
    finally { setDiscordBusy(undefined); }
  }
  async function managementComplete(message: string) { await load(); setNotice(message); }
  function deleted(deletion: Omit<PendingMeetingDeletion, "createdAt">) { window.sessionStorage.setItem(pendingMeetingDeletionKey, JSON.stringify({ ...deletion, createdAt: Date.now() })); navigate("/dashboard"); }

  const recurrence = meeting?.recurrenceFrequency
    ? `${frequencyLabel(meeting.recurrenceFrequency)}${meeting.recurrenceSequence ? ` · Occurrence ${meeting.recurrenceSequence}` : ""}${meeting.recurrenceUntil ? ` · Through ${new Date(meeting.recurrenceUntil).toLocaleDateString()}` : ""}`
    : "One time";
  const absenceEligible = Boolean(meeting?.required && clock >= Date.parse(meeting.startsAt));

  return <section className="attendance-workspace meeting-detail-workspace" aria-labelledby="meeting-detail-title">
    <nav className="meeting-detail-navigation" aria-label="Meeting detail navigation">
      <button type="button" onClick={() => navigate("/dashboard")}>Back to Dashboard</button>
      <label>Switch meeting<select className="ui-control ui-native-select" value={meeting?.id ?? ""} onChange={(event) => { if (event.target.value) navigate(`/meetings/${encodeURIComponent(event.target.value)}`); }}><option value="">Choose a meeting</option>{meetings.map((item) => <option key={item.id} value={item.id}>{new Date(item.startsAt).toLocaleDateString()} · {item.title}</option>)}</select></label>
    </nav>
    {meeting ? <>
      <header className="meeting-detail-heading"><div><span className={`meeting-lifecycle ${lifecycle}`}>{lifecycleLabel(lifecycle!)}</span><h1 id="meeting-detail-title">{meeting.title}</h1></div><div className="meeting-detail-actions"><button type="button" onClick={() => setManagementAction("edit")}>Edit</button><button type="button" onClick={() => setManagementAction("duplicate")}>Duplicate</button><button className="danger-button" type="button" onClick={() => setManagementAction("delete")}>Delete</button><button className="primary-button" type="button" onClick={() => void manualRefresh()}>Refresh attendance</button></div></header>
      <dl className="meeting-summary ui-card" aria-label="Meeting summary">
        <div><dt>Date</dt><dd>{new Date(meeting.startsAt).toLocaleDateString()}</dd></div>
        <div><dt>Time</dt><dd>{new Date(meeting.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–{new Date(meeting.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</dd></div>
        <div><dt>Attendance</dt><dd>{meeting.required ? "Required" : "Optional"}</dd></div><div><dt>Audience</dt><dd>{audience}</dd></div>
        <div><dt>Weight</dt><dd>{meeting.weightCategoryName ? `${meeting.weightCategoryName} · ` : ""}{meeting.attendanceWeight ?? 1}×</dd></div>
        <div><dt>Recurrence</dt><dd>{recurrence}</dd></div>
        <div className="meeting-summary-notes"><dt>Notes</dt><dd>{meeting.notes || "No notes"}</dd></div>
      </dl>
      {(calendarProviders.length > 0 || discordConfigured) && <section className="task-card meeting-actions-card ui-card" aria-labelledby="meeting-actions-title"><div className="panel-heading"><InfoHeading id="meeting-actions-title" info="Run calendar delivery and Discord operations for this meeting.">Meeting actions</InfoHeading></div><div className="meeting-actions-buttons">{calendarProviders.length > 0 && <button className="primary-button" type="button" disabled={calendarBusy} onClick={() => void syncCalendars()}>{calendarBusy ? "Syncing calendars…" : "Sync configured calendars"}</button>}{discordConfigured && <button className="ui-button" type="button" disabled={!absenceEligible || Boolean(discordBusy)} onClick={() => void notifyDiscordAbsences()}>{discordBusy === "absence" ? "Sending…" : "Send Discord absence notice"}</button>}</div>{calendarNotice && <p className="meeting-discord-notice ui-status" data-tone={calendarNoticeTone} role="status" aria-live="polite">{calendarNotice}</p>}{discordNotice && <p className="meeting-discord-notice ui-status" data-tone={discordNoticeTone} role="status" aria-live="polite">{discordNotice}</p>}</section>}
      {discordConfigured && contests.length > 0 && <section className="task-card meeting-contests ui-card" aria-labelledby="meeting-contests-title"><div className="panel-heading"><InfoHeading id="meeting-contests-title" info="Review requests submitted for this meeting.">Attendance contests</InfoHeading><span className="progress-count">{contests.length} open</span></div><ContestReviewList contests={contests} onResolved={(resolution, contest) => { setContests((current) => current.filter((item) => item.meetingId !== contest.meetingId || item.memberId !== contest.memberId)); setDiscordNotice(`Contest ${resolution}.`); setDiscordNoticeTone("success"); if (resolution === "approved") void refreshAttendance(meeting.id).catch((error: Error) => setNotice(error.message)); }} /></section>}
      <div className="attendance-utilities"><span role="status" aria-live="polite">{notice}</span><span className="progress-count">{rows.filter((row) => row.disposition === "present").length} present</span></div>
      <section className="attendance-card ui-card" aria-labelledby="meeting-attendance-title"><div className="panel-heading"><h2 id="meeting-attendance-title">Attendance</h2></div>{rows.length ? <div className="attendance-table" role="table" aria-label="Meeting attendance"><div className="attendance-row header" role="row"><span role="columnheader">Member</span><span role="columnheader">Scan times</span><span role="columnheader">Status</span><span role="columnheader">Actions</span></div>{rows.map((row) => <div className="attendance-row" role="row" key={row.memberId}><span role="cell"><RouteLink className="attendance-member-link" href={`/roster/${encodeURIComponent(row.externalId)}`} currentPath={path} navigate={navigate}><strong>{row.firstName} {row.lastName}</strong></RouteLink><small>{row.externalId} · {row.eligibility?.replace("_"," ")??"required"}{row.rateEligible?" · rate eligible":""}</small>{memberNotices[row.memberId] && <small className="member-action-notice" role="status">{memberNotices[row.memberId]}</small>}</span><div role="cell"><dl className="attendance-scan-times"><div><dt>Check-in</dt><dd>{row.checkedInAt ? <time dateTime={row.checkedInAt}>{formatScanTime(row.checkedInAt)}</time> : formatScanTime()}</dd></div><div><dt>Check-out</dt><dd>{row.checkedOutAt ? <time dateTime={row.checkedOutAt}>{formatScanTime(row.checkedOutAt)}</time> : formatScanTime()}</dd></div></dl></div><span role="cell" className={`attendance-state ${row.disposition}`}>{row.disposition === "active" ? "Active · not checked out" : row.disposition === "not_required" ? "Not required" : row.disposition}</span><span role="cell" className="correction-actions"><button type="button" disabled={row.disposition === "present"} onClick={() => void correct(row, "present")}>Present</button><button type="button" disabled={row.disposition === "excused"} onClick={() => void correct(row, "excused")}>Excuse</button><button type="button" disabled={row.disposition === "absent"} onClick={() => void correct(row, "absent")}>Absent</button>{role === "admin" && <button type="button" disabled={row.disposition === "not_required"} onClick={() => void clear(row)}>Clear</button>}</span></div>)}</div> : <p className="empty-state">No active roster records are available.</p>}</section>
      {managementAction === "edit" && <MeetingEditDialog meeting={meeting} onClose={() => setManagementAction(undefined)} onSaved={managementComplete} />}
      {managementAction === "duplicate" && <MeetingDuplicateDialog meeting={meeting} onClose={() => setManagementAction(undefined)} onCreated={managementComplete} />}
      {managementAction === "delete" && <MeetingDeleteDialog meeting={meeting} meetings={meetings} onClose={() => setManagementAction(undefined)} onDeleted={deleted} />}
    </> : <section className="empty-page ui-card"><h1 id="meeting-detail-title">Meeting unavailable</h1><p className="ui-status" data-tone="error" role="status">{notice}</p><p>The meeting may have been removed, or the link may be incorrect. Choose another meeting or return to Dashboard.</p></section>}
  </section>;
}
