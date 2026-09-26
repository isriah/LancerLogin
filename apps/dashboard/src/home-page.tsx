import { visiblePoll } from "./visible-poll";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { calendarDeliveryMessage, pendingMeetingDeletionKey, pendingMeetingDeletionLifetimeMs, readPendingMeetingDeletion, type CalendarDelivery, type CalendarSync, type PendingMeetingDeletion } from "./meeting-management";
import { MeetingCreationDialog, MeetingsPage, type Meeting, type MeetingTableState } from "./meetings-page";

import { usePageWalkthrough, WalkthroughDebugReset, WalkthroughPanel } from "./page-walkthrough";
import { dashboardWalkthrough } from "./dashboard-walkthrough";

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const dashboardMeetingViewKey = "lancerlogin-dashboard-meeting-view";
type MeetingView = "calendar" | "table";

export function HomePage({ navigate, discordEnabled, onWalkthroughChange, debugMode }: { onWalkthroughChange: (state: { open: boolean; navigation: boolean }) => void; role: "admin" | "operator"; navigate: (path: string) => void; discordEnabled: boolean; debugMode: boolean }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]); const [notice, setNotice] = useState("Loading dashboard…");
  const [noticeTone, setNoticeTone] = useState<"neutral" | "success" | "error">("neutral");
  const [meetingView, setMeetingView] = useState<MeetingView>(() => window.localStorage.getItem(dashboardMeetingViewKey) === "table" ? "table" : "calendar");
  const [calendarOffset, setCalendarOffset] = useState(0); const [creating, setCreating] = useState(false); const [creationNotice, setCreationNotice] = useState("");
  const [undo, setUndo] = useState<PendingMeetingDeletion | undefined>(() => readPendingMeetingDeletion(window.sessionStorage.getItem(pendingMeetingDeletionKey)));
  const [tableState, setTableState] = useState<MeetingTableState>({ search: "", selectedIds: [] });
  const walkthrough = usePageWalkthrough("dashboard", notice === "" && !undo && !creating);
  const active = walkthrough.phase === "active";
  const step = active ? dashboardWalkthrough[walkthrough.stepIndex] : undefined;
  const shownView = active && walkthrough.stepIndex < 3 ? "calendar" : active && walkthrough.stepIndex >= 4 && walkthrough.stepIndex < 6 ? "table" : meetingView;
  const practiceForm = active && walkthrough.stepIndex >= 6;
  const savedState = useRef<{ view: MeetingView; offset: number; table: MeetingTableState } | undefined>(undefined);
  const dashboardHeading = useRef<HTMLHeadingElement>(null);
  function startWalkthrough(restart = false) {
    savedState.current = { view: meetingView, offset: calendarOffset, table: tableState };
    walkthrough.start(restart);
  }
  useEffect(() => {
    onWalkthroughChange({ open: walkthrough.phase !== "idle", navigation: active && walkthrough.stepIndex === 0 });
  }, [walkthrough.phase, walkthrough.stepIndex, onWalkthroughChange]);
  useEffect(() => () => onWalkthroughChange({ open: false, navigation: false }), [onWalkthroughChange]);
  useEffect(() => {
    if (!active && savedState.current) {
      setMeetingView(savedState.current.view); setCalendarOffset(savedState.current.offset); setTableState(savedState.current.table); savedState.current = undefined;
    }
    if (walkthrough.phase === "idle") dashboardHeading.current?.focus();
  }, [active, walkthrough.stepIndex, walkthrough.phase]);
  const openMeeting = (path: string) => { if (!active) navigate(path); };
  useDashboardLoadingOverlay(notice === "Loading dashboard…", "Loading dashboard…");
  async function load() {
    const result = await api<{ meetings: Meeting[] }>("/meetings");
    setMeetings(result.meetings); setNotice(""); setNoticeTone("neutral");
  }
  useEffect(() => { return visiblePoll(load, 60_000, (error) => { setNotice(error.message); setNoticeTone("error"); }, true); }, [discordEnabled]);
  useEffect(() => {
    if (!undo) { window.sessionStorage.removeItem(pendingMeetingDeletionKey); return; }
    // The session entry is a one-navigation handoff. Keeping it out of storage
    // prevents a refresh or unrelated return to Dashboard from resurrecting it.
    window.sessionStorage.removeItem(pendingMeetingDeletionKey);
    const timer = window.setTimeout(() => setUndo(undefined), Math.max(0, pendingMeetingDeletionLifetimeMs - (Date.now() - undo.createdAt)));
    return () => window.clearTimeout(timer);
  }, [undo]);
  const days = useMemo(() => { const currentWeek = new Date(); currentWeek.setHours(0, 0, 0, 0); currentWeek.setDate(currentWeek.getDate() - currentWeek.getDay()); const start = new Date(currentWeek); start.setDate(start.getDate() - 7 + calendarOffset * 35); return Array.from({ length: 35 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; }); }, [calendarOffset]);
  const events = useMemo(() => new Map(days.map((day) => [dayKey(day), meetings.filter((meeting) => dayKey(new Date(meeting.startsAt)) === dayKey(day)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))])), [days, meetings]);
  function chooseView(view: MeetingView) { if (!active) window.localStorage.setItem(dashboardMeetingViewKey, view); setMeetingView(view); }
  function addMeeting() { if (active) return; setCreationNotice(""); setCreating(true); }
  async function created(count: number, calendarSync?: CalendarSync, calendarDelivery?: CalendarDelivery) { const success = `${count} ${count === 1 ? "meeting" : "meetings"} created.${calendarDeliveryMessage(calendarDelivery, calendarSync)}`; try { await load(); setCreationNotice(success); setNoticeTone(calendarDelivery?.google_calendar.failed || calendarDelivery?.discord.failed || calendarSync?.failed ? "error" : "success"); } catch { setCreationNotice(`${success} Refresh Dashboard to see the latest meeting list.`); setNoticeTone("error"); } }
  async function restore() { if (!undo) return; try { const result = await api<{ calendarSync?: CalendarSync; calendarDelivery?: CalendarDelivery }>(`/meetings/${encodeURIComponent(undo.meetingId)}/restore`, { method: "POST", body: JSON.stringify({ scope: undo.scope }) }); window.sessionStorage.removeItem(pendingMeetingDeletionKey); setUndo(undefined); await load(); setCreationNotice(`${undo.scope === "future" ? "This and future series occurrences were restored." : `${undo.title} was restored.`}${calendarDeliveryMessage(result.calendarDelivery, result.calendarSync)}`); setNoticeTone(result.calendarDelivery?.google_calendar.failed || result.calendarDelivery?.discord.failed || result.calendarSync?.failed ? "error" : "success"); } catch (error) { setCreationNotice((error as Error).message); setNoticeTone("error"); } }
  const rangeLabel = `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} – ${days.at(-1)!.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  return <section className="page-stack dashboard-home" aria-labelledby="home-title">
    <div className="page-intro"><h1 ref={dashboardHeading} id="home-title" tabIndex={-1}>Dashboard</h1></div>
    {walkthrough.error && walkthrough.phase === "idle" && <p className="ui-status" data-tone="error" role="status">{walkthrough.error}</p>}
    {(creationNotice || notice) && <p className="setup-status ui-status dashboard-meeting-status" data-tone={noticeTone} role="status">{creationNotice || notice}</p>}
    {undo && <div className="undo-meeting ui-status" data-tone={undo.calendarDelivery?.google_calendar.failed || undo.calendarDelivery?.discord.failed || undo.calendarSync?.failed ? "error" : "success"} role="status"><span>{undo.scope === "future" ? "This and future series occurrences were deleted." : `${undo.title} was deleted.`}{calendarDeliveryMessage(undo.calendarDelivery, undo.calendarSync)}</span><button type="button" onClick={() => void restore()}>Undo</button></div>}
    <section className="meeting-browser-controls ui-card" aria-label="Meeting browser controls">
      <fieldset data-walkthrough="meeting-view" className="meeting-view-toggle"><legend>Meeting view</legend><div><label className={shownView === "calendar" ? "selected" : ""}><input type="radio" name="meeting-view" value="calendar" checked={shownView === "calendar"} onChange={() => chooseView("calendar")} />Calendar</label><label className={shownView === "table" ? "selected" : ""}><input type="radio" name="meeting-view" value="table" checked={shownView === "table"} onChange={() => chooseView("table")} />Table</label></div></fieldset>
      <label data-walkthrough="meeting-picker" className="meeting-browser-select"><span>Meeting</span><select className="ui-control ui-native-select" value="" onChange={(event) => { if (event.target.value) openMeeting(`/meetings/${encodeURIComponent(event.target.value)}`); }}><option value="">Choose a meeting</option>{meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{new Date(meeting.startsAt).toLocaleDateString()} · {meeting.title}</option>)}</select></label>
      <button className="primary-button" type="button" onClick={addMeeting}>Add meeting</button>
    </section>
    {shownView === "calendar" ? <section className="rolling-calendar dashboard-meeting-calendar ui-card" aria-labelledby="calendar-title"><div className="section-heading calendar-heading"><div><h2 id="calendar-title">Meeting calendar</h2><p aria-live="polite">{rangeLabel}</p></div><div data-walkthrough="calendar-navigation" className="calendar-navigation"><button type="button" aria-label="Show previous five weeks" onClick={() => setCalendarOffset((value) => value - 1)}>←</button><button type="button" disabled={calendarOffset === 0} onClick={() => setCalendarOffset(0)}>Today</button><button type="button" aria-label="Show next five weeks" onClick={() => setCalendarOffset((value) => value + 1)}>→</button></div></div>{meetings.length === 0 && noticeTone !== "error" && <p className="empty-state calendar-empty-state">No meetings are scheduled in this five-week range.</p>}<div className="calendar-weekdays" aria-hidden="true">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{days.map((day) => { const now = new Date(); const today = dayKey(day) === dayKey(now); const previousMonth = day.getFullYear() * 12 + day.getMonth() < now.getFullYear() * 12 + now.getMonth(); const items = events.get(dayKey(day)) ?? []; return <article key={dayKey(day)} className={`calendar-day${today ? " today" : ""}${previousMonth ? " previous-month" : ""}`}><header><span>{day.toLocaleDateString(undefined, { month: "short" })}</span><strong>{day.getDate()}</strong></header>{items.map((meeting) => <button data-walkthrough="calendar-entry" key={meeting.id} type="button" onClick={() => openMeeting(`/meetings/${encodeURIComponent(meeting.id)}`)} title={`${meeting.title}, ${new Date(meeting.startsAt).toLocaleString()} to ${new Date(meeting.endsAt).toLocaleTimeString()}`}><span>{new Date(meeting.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>{meeting.title}</button>)}</article>; })}</div></section> : <MeetingsPage state={tableState} onStateChange={setTableState} practice={active} discordEnabled={discordEnabled} navigate={openMeeting} embedded meetings={meetings} onMeetingsChange={load} />}
    <MeetingCreationDialog key={practiceForm ? "practice" : "live"} practice={practiceForm} open={creating || practiceForm} meetings={meetings} discordEnabled={discordEnabled} onClose={() => practiceForm ? walkthrough.exit() : setCreating(false)} onCreated={created} />
    {walkthrough.phase === "idle" && !walkthrough.loading && !creating && !undo && notice === "" && <WalkthroughDebugReset debugMode={debugMode} disabled={false} onReset={walkthrough.reset} />}
    {walkthrough.phase !== "idle" && <WalkthroughPanel step={step} onExit={walkthrough.exit} label={step ? "Dashboard walkthrough" : walkthrough.phase === "complete" ? "Walkthrough complete" : "Get ready for your next meeting"}>
      {walkthrough.phase === "welcome" ? <>
        <h2 data-walkthrough-focus tabIndex={-1}>Get ready for your next meeting</h2>
        <p>Learn to find scheduled meetings, explore the calendar and table, and plan a new meeting. Practice won't save or delete meetings.</p>
        <div className="walkthrough-actions"><button className="ui-button ui-button--primary" onClick={() => startWalkthrough()}>{walkthrough.canResume ? "Resume walkthrough" : "Start walkthrough"}</button>{walkthrough.canResume && <button className="ui-button" onClick={() => startWalkthrough(true)}>Start over</button>}<button className="ui-button" onClick={walkthrough.exit}>Not now</button><button className="ui-button" onClick={walkthrough.dismiss}>Don't show automatically again</button></div>
      </> : walkthrough.phase === "complete" ? <>
        <h2 data-walkthrough-focus tabIndex={-1}>You're ready to prepare for your next meeting</h2>
        <p>Find it in Calendar or Table, open it to manage attendance, or add a meeting when you need one.</p>
        <div className="walkthrough-actions"><button className="ui-button ui-button--primary" onClick={walkthrough.exit}>Done</button><button className="ui-button" onClick={() => { walkthrough.exit(); addMeeting(); }}>Add meeting</button></div>
      </> : step && <>
        <p className="walkthrough-progress" role="status">Step {walkthrough.stepIndex + 1} of {dashboardWalkthrough.length}</p>
        <h2 data-walkthrough-focus tabIndex={-1}>{step.title}</h2><p>{step.description}</p>
        {step.id === "navigation" && <p>{document.querySelector(".contest-indicator") ? "The contest indicator opens attendance requests awaiting review. " : ""}{document.querySelector(".update-indicator") ? "Update available opens the Updates page for Administrators." : ""}</p>}
        {step.id === "selection" && meetings.length === 0 && <p>Selection checkboxes will appear when meetings exist.</p>}
        <div className="walkthrough-actions"><button className="ui-button" disabled={walkthrough.stepIndex === 0} onClick={() => walkthrough.move(walkthrough.stepIndex - 1)}>Back</button><button className="ui-button ui-button--primary" onClick={() => walkthrough.move(walkthrough.stepIndex + 1)}>Next</button><button className="ui-button" onClick={walkthrough.exit}>Exit</button><button className="ui-button" onClick={walkthrough.dismiss}>Don't show automatically again</button></div>
      </>}
      {walkthrough.error && <p className="ui-status" data-tone="error" role="status">{walkthrough.error}</p>}
    </WalkthroughPanel>}
  </section>;
}
