import { visiblePoll } from "./visible-poll";
import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { calendarDeliveryMessage, type CalendarDelivery, type CalendarSync, type PendingMeetingDeletion } from "./meeting-management";
import { clearMeetingDeletion, readMeetingDeletion } from "./meeting-deletion-undo";
import { MeetingCreationDialog, MeetingsPage, type Meeting, type MeetingTableState } from "./meetings-page";
import { CalendarViewToggle, MonthCalendar } from "./mobile-calendar";
import { CarpoolMarker, useCarpoolMeetingLinks } from "./carpool-meeting-links";

import { usePageWalkthrough, WalkthroughDebugReset, WalkthroughPanel } from "./page-walkthrough";
import { dashboardWalkthrough } from "./dashboard-walkthrough";

const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const dashboardMeetingViewKey = "lancerlogin-dashboard-meeting-view";
type MeetingView = "calendar" | "table";

export function HomePage({ navigate, discordEnabled, onWalkthroughChange, debugMode }: { onWalkthroughChange: (state: { open: boolean; navigation: boolean }) => void; role: "admin" | "operator"; navigate: (path: string) => void; discordEnabled: boolean; debugMode: boolean }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]); const [notice, setNotice] = useState("Loading dashboard…");
  const carpoolLinks = useCarpoolMeetingLinks(meetings);
  const [noticeTone, setNoticeTone] = useState<"neutral" | "success" | "error">("neutral");
  const [meetingView, setMeetingView] = useState<MeetingView>(() => window.localStorage.getItem(dashboardMeetingViewKey) === "table" ? "table" : "calendar");
  const [calendarOffset, setCalendarOffset] = useState(0); const [creating, setCreating] = useState(false); const [creationNotice, setCreationNotice] = useState("");
  const [undo, setUndo] = useState<PendingMeetingDeletion | undefined>(readMeetingDeletion);
  const [undoBusy, setUndoBusy] = useState(false); const [deleteBusy, setDeleteBusy] = useState(false); const restoring = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; clearMeetingDeletion(); return () => { mounted.current = false; }; }, []);
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
  function chooseView(view: MeetingView) { if (!active) window.localStorage.setItem(dashboardMeetingViewKey, view); setMeetingView(view); }
  function addMeeting() { if (active) return; setCreationNotice(""); setCreating(true); }
  async function created(count: number, calendarSync?: CalendarSync, calendarDelivery?: CalendarDelivery) { const success = `${count} ${count === 1 ? "meeting" : "meetings"} created.${calendarDeliveryMessage(calendarDelivery, calendarSync)}`; try { await load(); setCreationNotice(success); setNoticeTone(calendarDelivery?.google_calendar.failed || calendarDelivery?.discord.failed || calendarSync?.failed ? "error" : "success"); } catch { setCreationNotice(`${success} Refresh Dashboard to see the latest meeting list.`); setNoticeTone("error"); } }
  function deleted(deletion: PendingMeetingDeletion) { if (mounted.current) { setCreationNotice(""); setUndo(deletion); } }
  async function restore() {
    if (!undo || deleteBusy || restoring.current) return;
    restoring.current = true; setUndoBusy(true); setCreationNotice("");
    try {
      const result = await api<{ restored: number; calendarSync?: CalendarSync; calendarDelivery?: CalendarDelivery }>(`/meetings/${encodeURIComponent(undo.deletion.meetingIds[0])}/restore`, { method: "POST", body: JSON.stringify({ scope: undo.scope, deletion: undo.deletion }) });
      if (!mounted.current) return;
      setUndo(undefined);
      const success = `${undo.scope === "future" ? "This and future series occurrences were restored." : `${result.restored} ${result.restored === 1 ? "meeting was" : "meetings were"} restored.`}${calendarDeliveryMessage(result.calendarDelivery, result.calendarSync)}`;
      try { await load(); setCreationNotice(success); setNoticeTone(result.calendarDelivery?.google_calendar.failed || result.calendarDelivery?.discord.failed || result.calendarSync?.failed ? "error" : "success"); }
      catch { setCreationNotice(`${success} Refresh Dashboard to see the latest meeting list.`); setNoticeTone("error"); }
    } catch (error) { if (mounted.current) { setCreationNotice(`Undo failed: ${(error as Error).message}`); setNoticeTone("error"); } }
    finally { restoring.current = false; if (mounted.current) setUndoBusy(false); }
  }
  return <section className="page-stack dashboard-home operational-browser-page" aria-labelledby="home-title">
    <div className="page-intro operational-page-intro compact-browser-heading"><h1 ref={dashboardHeading} id="home-title" tabIndex={-1}>Dashboard</h1><CalendarViewToggle name="meeting-view" label="Meeting view" value={shownView} onChange={chooseView} /></div>
    {walkthrough.error && walkthrough.phase === "idle" && <p className="ui-status" data-tone="error" role="status">{walkthrough.error}</p>}
    {(creationNotice || notice) && <p className="setup-status ui-status dashboard-meeting-status" data-tone={noticeTone} role="status">{creationNotice || notice}</p>}
    {undo && <div className="undo-meeting ui-status" data-tone={undo.calendarDelivery?.google_calendar.failed || undo.calendarDelivery?.discord.failed || undo.calendarSync?.failed ? "error" : "success"} role="status"><span>{undo.message}{calendarDeliveryMessage(undo.calendarDelivery, undo.calendarSync)}</span><button className="ui-button" type="button" disabled={undoBusy || deleteBusy} onClick={() => void restore()}>{undoBusy ? "Restoring…" : "Undo"}</button></div>}
    {shownView === "table" && <section className="meeting-browser-controls compact-table-controls ui-card" aria-label="Meeting browser controls"><label data-walkthrough="meeting-picker" className="meeting-browser-select"><span>Meeting</span><select className="ui-control ui-native-select" value="" onChange={(event) => { if (event.target.value) openMeeting(`/meetings/${encodeURIComponent(event.target.value)}`); }}><option value="">Choose a meeting</option>{meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{new Date(meeting.startsAt).toLocaleDateString()} · {meeting.title}</option>)}</select></label><button className="primary-button" type="button" onClick={addMeeting}><span aria-hidden="true">+ </span>Add meeting</button></section>}
    {shownView === "calendar" ? <MonthCalendar title="Meeting calendar" id="calendar-title" showToday today={dayKey(new Date())} offset={calendarOffset} onOffset={setCalendarOffset} items={[...meetings].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))} itemDate={meeting => dayKey(new Date(meeting.startsAt))} emptyText="No meetings scheduled." action={<button className="primary-button" type="button" onClick={addMeeting}><span aria-hidden="true">+ </span>Add meeting</button>} renderItem={meeting => <article className="calendar-selected-record" key={meeting.id}><strong className="carpool-meeting-title">{meeting.title}<CarpoolMarker count={carpoolLinks.filter(link => link.meetingId === meeting.id).length} /></strong><p>{new Date(meeting.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} - {new Date(meeting.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {meeting.required ? "Required" : "Optional"}</p>{meeting.notes && <p>{meeting.notes}</p>}<button className="ui-button" data-walkthrough="calendar-entry" type="button" onClick={() => openMeeting(`/meetings/${encodeURIComponent(meeting.id)}`)}>Open meeting<span className="visually-hidden"> {meeting.title}</span></button></article>} /> : <MeetingsPage state={tableState} onStateChange={setTableState} practice={active} discordEnabled={discordEnabled} navigate={openMeeting} embedded meetings={meetings} onMeetingsChange={load} onDeleted={deleted} deleteDisabled={undoBusy} onDeleteBusyChange={setDeleteBusy} />}
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
