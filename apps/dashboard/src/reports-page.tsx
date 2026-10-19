import "./mobile-roster-reports.css";
import { isMemberReport, membersDataset, reportDisplayDataset, reportTypes, useMemberFields } from "./member-report-types";
import { ReportLeaveDialog, type ReportEditorHandle, type ReportSaveResult } from "./report-leave-dialog";
import { latestTrendPoints, reportExportFilename } from "./report-view";
import { AttendanceTrendChart } from "./attendance-trend-chart";
import { PageWalkthroughExperience } from "./page-walkthrough";
import { pageWalkthroughForPath } from "./page-walkthrough-definitions";
import { exampleReportDefinition, exampleReportName } from "./report-template";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, apiBaseUrl } from "./dashboard-api";
import { RouteLink, routeWillChangeEvent, usePath } from "./router";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { attendanceRateText, policyResultText, reportQuery, type AttendanceReport, type ReportFilters } from "./report-attendance";
import { InfoHeading } from "./info-tip";
import { EditableReportTable } from "./report-result-table";
import { cloneReportDefinition, reportColumnId, reportColumnLabel, sameReportDefinition, type ReportCatalog, type ReportDefinition, type ReportQueryResult, type ReportScope, type SavedReport } from "./saved-reports";

type Contest = { meetingId: string; memberId: string; firstName: string; lastName: string; meetingTitle: string; status: "open" | "approved" | "rejected" | "reviewed"; createdAt: string };
type LegacyView = { from?: string; to?: string; meetingType?: "all" | "required" | "optional"; roster?: "active" | "all"; labelId?: string; membership?: "current" | "historical"; useBaseline?: boolean };
type Draft = { name: string; scope: ReportScope; definition: ReportDefinition; imported?: boolean };
const legacyViewKey = "lancerlogin-reports-view";
const draftKey = "lancerlogin-report-draft-v1";
function storedDraft(): Draft | undefined { try { return JSON.parse(sessionStorage.getItem(draftKey) ?? "") as Draft; } catch { return undefined; } }
function saveDraft(draft: Draft) { sessionStorage.setItem(draftKey, JSON.stringify(draft)); }
function directReportId(path: string) { return path.startsWith("/reports/view/") ? decodeURIComponent(path.slice("/reports/view/".length)) : undefined; }

export function ReportsPage({ discordEnabled, debugMode, onWalkthroughChange }: { discordEnabled: boolean; debugMode: boolean; onWalkthroughChange: (state: { open: boolean; navigation: boolean }) => void }) {
  const { path, navigate } = usePath();
  const [exampleBusy, setExampleBusy] = useState(false); const examplePending = useRef(false);
  const [exampleId, setExampleId] = useState<string>(); const [exampleError, setExampleError] = useState("");
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [catalog, setCatalog] = useState<ReportCatalog>(); const [reports, setReports] = useState<SavedReport[]>([]); const [notice, setNotice] = useState("Loading reports…"); const [browse, setBrowse] = useState(""); const [dirty, setDirty] = useState(false); const [pinBusy, setPinBusy] = useState(false); const pinPending = useRef(false); const allowNextRoute = useRef(false);
  useDashboardLoadingOverlay(notice === "Loading reports…", "Loading reports…");
  async function loadLibraries() { const [nextCatalog, library] = await Promise.all([api<ReportCatalog>("/reports/catalog"), api<{ reports: SavedReport[] }>("/reports/views")]); setCatalog(nextCatalog); setReports(library.reports); setNotice(""); }
  useEffect(() => { let active = true; void Promise.all([api<ReportCatalog>("/reports/catalog"), api<{ reports: SavedReport[] }>("/reports/views")]).then(([nextCatalog, library]) => { if (!active) return; setCatalog(nextCatalog); setReports(library.reports); setNotice(""); }).catch((error: Error) => { if (active) setNotice(error.message); }); return () => { active = false; }; }, []);
  const pinned = useMemo(() => reports.filter((item) => item.pinnedPosition !== null).sort((a, b) => Number(a.pinnedPosition) - Number(b.pinnedPosition)), [reports]); const reportId = directReportId(path); const selected = reportId ? reports.find((item) => item.id === reportId) : undefined;
  async function persistPins(reportIds: string[]) { if (pinPending.current) return false; pinPending.current = true; setPinBusy(true); try { await api("/reports/tabs", { method: "PUT", body: JSON.stringify({ reportIds }) }); await loadLibraries(); return true; } catch (error) { setNotice((error as Error).message); return false; } finally { pinPending.current = false; setPinBusy(false); } }
  const editor = useRef<ReportEditorHandle>(null);
  const [pendingLeave, setPendingLeave] = useState<{ action: () => void | Promise<void> }>();
  function requestLeave(action: () => void | Promise<void>) { if (dirty) setPendingLeave({ action }); else void action(); }
  function finishLeave(next: string) { if (path === "/reports/new") sessionStorage.removeItem(draftKey); allowNextRoute.current = true; setDirty(false); navigate(next); }
  function leave(next: string) { if (next !== path) requestLeave(() => finishLeave(next)); }
  useEffect(() => {
    const guard = (event: Event) => {
      if (allowNextRoute.current) { allowNextRoute.current = false; return; }
      const next = (event as CustomEvent<{ next: string }>).detail.next;
      if (!dirty || next === path) return;
      event.preventDefault(); setPendingLeave({ action: () => finishLeave(next) });
    };
    window.addEventListener(routeWillChangeEvent, guard);
    return () => window.removeEventListener(routeWillChangeEvent, guard);
  }, [dirty, path]);
  function openReport(report: SavedReport) { leave(`/reports/view/${encodeURIComponent(report.id)}`); }
  function unpin(id: string) {
    const action = async () => { if (await persistPins(pinned.filter((item) => item.id !== id).map((item) => item.id)) && reportId === id) finishLeave("/reports"); };
    if (reportId === id) requestLeave(action); else void action();
  }
  function importedDraft(): Draft | undefined { try { const legacy = JSON.parse(localStorage.getItem(legacyViewKey) ?? "") as LegacyView; if (!catalog?.attendanceAvailable) return; const period = legacy.useBaseline && catalog.baseline ? { type: "baseline" as const } : legacy.from || legacy.to ? { type: "fixed" as const, from: legacy.from || "2000-01-01", to: legacy.to || new Date().toISOString().slice(0, 10) } : { type: "all" as const }; const attendance = catalog.datasets.find((dataset) => dataset.id === "attendance.members")!; return { name: "Imported attendance view", scope: "personal", imported: true, definition: { ...cloneReportDefinition(catalog.defaultDefinition), dataset: attendance.id, groupBy: [...attendance.groupBy], columns: attendance.defaultColumns.map((key) => ({ key })), sort: { column: { key: attendance.defaultSort.field }, direction: attendance.defaultSort.direction }, period, meetingType: legacy.meetingType ?? "all", roster: legacy.roster ?? "active", labelIds: legacy.labelId ? [legacy.labelId] : [], membership: legacy.membership ?? "current" } }; } catch { return; } }
  async function addExampleReport() {
    if (examplePending.current || !catalog?.attendanceAvailable) return;
    examplePending.current = true; setExampleBusy(true); setExampleError("");
    try {
      let name = exampleReportName; let suffix = 2;
      while (reports.some((report) => report.scope === "personal" && report.name.toLowerCase() === name.toLowerCase())) name = exampleReportName + " " + suffix++;
      const { report } = await api<{ report: SavedReport }>("/reports/views", { method: "POST", body: JSON.stringify({ name, scope: "personal", definition: exampleReportDefinition() }) });
      if (!mounted.current) return;
      setReports((current) => [...current.filter((item) => item.id !== report.id), report]);
      setExampleId(report.id); finishLeave('/reports/view/' + encodeURIComponent(report.id));
    } catch (error) { if (mounted.current) setExampleError((error as Error).message + " Check Browse reports before trying again."); }
    finally { examplePending.current = false; if (mounted.current) setExampleBusy(false); }
  }
  const legacyDraft = importedDraft(); const available = reports.filter((item) => item.name.toLowerCase().includes(browse.toLowerCase()));
  const visibleTabs = selected && selected.pinnedPosition === null ? [...pinned, selected] : pinned;
  return <><section className="page-stack reports-page" aria-labelledby="reports-title" data-walkthrough-page="reports" data-walkthrough-ready={catalog ? "true" : undefined} tabIndex={-1}>
    <div className="page-intro"><h1 id="reports-title">Reports</h1></div>{notice && <p className="setup-status" role="status">{notice}</p>}
    <nav className="report-tabs" data-walkthrough="reports-tabs" aria-label="Report pages">{catalog?.attendanceAvailable && <button className={path === "/reports" ? "active" : ""} type="button" onClick={() => leave("/reports")}>Leaderboard</button>}{visibleTabs.map((item) => <span className={`report-tab${reportId === item.id ? " active" : ""}`} key={item.id}><button type="button" onClick={() => leave(`/reports/view/${encodeURIComponent(item.id)}`)} aria-current={reportId === item.id ? "page" : undefined}>{item.name}</button><button className="tab-close" type="button" disabled={pinBusy} title={item.pinnedPosition === null ? "Close report" : "Unpin report"} aria-label={(item.pinnedPosition === null ? "Close " : "Unpin ") + item.name} onClick={() => item.pinnedPosition === null ? leave("/reports") : void unpin(item.id)}>×</button></span>)}<ReportBrowser browse={browse} onBrowse={setBrowse}>{legacyDraft && <div className="browse-report-row"><button type="button" onClick={() => { requestLeave(() => { finishLeave("/reports/new"); saveDraft(legacyDraft); }); }}>Imported browser view <small>Unsaved draft</small></button><button type="button" aria-label="Dismiss imported browser view" onClick={() => { localStorage.removeItem(legacyViewKey); setNotice("Imported browser view dismissed."); }}>×</button></div>}{available.map((item) => <div className="browse-report-row" key={item.id}><button className="ui-button" type="button" aria-current={item.id === reportId ? "page" : undefined} onClick={() => openReport(item)}>{item.name}<small>{item.scope}{item.id === reportId ? " · Open" : ""}{item.pinnedPosition !== null ? " · Pinned" : ""}</small></button><button className="ui-button" type="button" disabled={pinBusy} aria-label={(item.pinnedPosition === null ? "Pin " : "Unpin ") + item.name} onClick={() => void persistPins(item.pinnedPosition === null ? [...pinned.map((report) => report.id), item.id] : pinned.filter((report) => report.id !== item.id).map((report) => report.id))}>{item.pinnedPosition === null ? "Pin" : "Unpin"}</button></div>)}{!available.length && !legacyDraft && <p>No reports match.</p>}</ReportBrowser><button className="ui-button report-add-tab" type="button" onClick={() => leave("/reports/new")}>New report</button></nav>
    {!catalog ? <p className="empty-state">Report controls are unavailable.</p> : path === "/reports" ? catalog.attendanceAvailable ? <Leaderboard discordEnabled={discordEnabled} initialBaseline={catalog.baseline} /> : <ReportStart catalog={catalog} onCreate={(definition) => { saveDraft({ name: "Untitled report", scope: "personal", definition }); leave("/reports/new"); }} /> : path === "/reports/new" ? <ReportEditor key="new" catalog={catalog} draft={storedDraft()} pinnedIds={pinned.map((item) => item.id)} editorRef={editor} onDirtyChange={setDirty} onLibrariesChanged={loadLibraries} onNavigate={navigate} onSavedNavigate={finishLeave} onTogglePin={async (id) => { await persistPins(pinned.some((report) => report.id === id) ? pinned.filter((report) => report.id !== id).map((report) => report.id) : [...pinned.map((report) => report.id), id]); }} /> : selected ? <ReportEditor key={selected.id} catalog={catalog} saved={selected} pinnedIds={pinned.map((item) => item.id)} editorRef={editor} onDirtyChange={setDirty} onLibrariesChanged={loadLibraries} onNavigate={navigate} onSavedNavigate={finishLeave} onTogglePin={async (id) => { await persistPins(pinned.some((report) => report.id === id) ? pinned.filter((report) => report.id !== id).map((report) => report.id) : [...pinned.map((report) => report.id), id]); }} /> : reportId ? <section className="ui-card empty-page"><h2>Report unavailable</h2><p>This report was deleted or is private to another account.</p><button type="button" onClick={() => navigate("/reports")}>Return to Reports</button></section> : null}
  </section>
  {pendingLeave && <ReportLeaveDialog onSave={() => editor.current?.save() ?? Promise.resolve({ ok: false, error: "The report is unavailable. Cancel to return to Reports." })} onLeave={async () => { await pendingLeave.action(); setPendingLeave(undefined); }} onCancel={() => setPendingLeave(undefined)} />}
  {catalog?.attendanceAvailable && <PageWalkthroughExperience definition={pageWalkthroughForPath(path, catalog.role)!} debugMode={debugMode} onStateChange={onWalkthroughChange} renderStepAction={(step) => step.id === "report-builder" ? <>
    <p>Optionally add a personal monthly report with member names, labels, attendance counts, and report-period policy results. It uses your roster and stays saved after this walkthrough.</p>
    {exampleId ? <p className="ui-status" data-tone="success" role="status">Example report saved. You can edit or delete it later.</p> : <button className="ui-button" type="button" disabled={exampleBusy} onClick={() => requestLeave(addExampleReport)}>{exampleBusy ? "Adding example…" : "Add example report"}</button>}
    {exampleError && <p className="ui-status" data-tone="error" role="alert">{exampleError}</p>}
  </> : null} />}</>;
}

function ReportBrowser({ browse, onBrowse, children }: { browse: string; onBrowse: (value: string) => void; children: React.ReactNode }) {
  const details = useRef<HTMLDetailsElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  useDismissableDetails(details, popover);
  function updatePosition() {
    const summary = details.current?.querySelector("summary");
    if (!summary) return;
    const rect = summary.getBoundingClientRect();
    const width = Math.min(384, window.innerWidth - 32);
    setPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), top: rect.bottom + 8 });
  }
  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => { window.removeEventListener("resize", updatePosition); window.removeEventListener("scroll", updatePosition, true); };
  }, [open]);
  const style = { "--report-browser-left": `${position.left}px`, "--report-browser-top": `${position.top}px` } as CSSProperties;
  const portalTarget = details.current?.closest(".app") ?? document.body;
  return <details ref={details} className="report-browser" onToggle={(event) => { const next = event.currentTarget.open; setOpen(next); if (next) updatePosition(); }}><summary>Browse reports</summary>{open && createPortal(<div ref={popover} className="report-browser-popover" style={style} onClick={(event) => { if ((event.target as Element).closest(".browse-report-row > button:first-child") && details.current) details.current.open = false; }}><label>Search reports<input type="search" value={browse} onChange={(event) => onBrowse(event.target.value)} /></label>{children}</div>, portalTarget)}</details>;
}

function useDismissableDetails(details: React.RefObject<HTMLDetailsElement | null>, popover?: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const dismiss = (returnFocus = false) => {
      const element = details.current;
      if (!element?.open) return;
      element.open = false;
      if (returnFocus) element.querySelector<HTMLElement>("summary")?.focus();
    };
    const outside = (event: PointerEvent) => { if (!details.current?.contains(event.target as Node) && !popover?.current?.contains(event.target as Node)) dismiss(); };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(true); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", keydown); };
  }, [details, popover]);
}

type LeaderboardReport = AttendanceReport & { pagination: ReportQueryResult["pagination"]; insights: { policyAlerts: { key: string; memberId: string; name: string; policy: import("./report-attendance").ReportCompliance }[]; trend: { meetingId: string; title: string; startsAt: string; rate: number }[] } };
function Leaderboard({ discordEnabled, initialBaseline }: { discordEnabled: boolean; initialBaseline: string | null }) {
  const { path, navigate } = usePath(); const [report, setReport] = useState<LeaderboardReport>(); const [contests, setContests] = useState<Contest[]>([]); const [notice, setNotice] = useState("Loading leaderboard…"); const [sort, setSort] = useState<"regular-desc" | "first-name" | "last-name">("regular-desc"); const [range, setRange] = useState("10"); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [meetingType, setMeetingType] = useState<"all" | "required" | "optional">("all"); const [roster, setRoster] = useState<"active" | "all">("active"); const [labelId, setLabelId] = useState(""); const [membership, setMembership] = useState<"current" | "historical">("current"); const [baseline, setBaseline] = useState(initialBaseline ?? ""); const [useBaseline, setUseBaseline] = useState(true); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState<25 | 50 | 100 | "all">(25); const [reviewing, setReviewing] = useState<Contest>(); const [reviewNote, setReviewNote] = useState(""); const [reviewError, setReviewError] = useState(""); const [reviewBusy, setReviewBusy] = useState(false);
  const [contestError, setContestError] = useState("");
  const filters: ReportFilters = useMemo(() => ({ from: useBaseline ? baseline || undefined : from || undefined, to: to || undefined, meetingType, roster, labelId: labelId || undefined, membership }), [useBaseline, baseline, from, to, meetingType, roster, labelId, membership]);
  const query = useMemo(() => { const value = new URLSearchParams(reportQuery(filters)); value.set("sort", sort); value.set("page", String(page)); value.set("pageSize", String(pageSize)); return value.toString(); }, [filters, sort, page, pageSize]);
  useEffect(() => { let active = true; setNotice("Loading leaderboard…"); void api<LeaderboardReport>(`/reports/leaderboard?${query}`).then((result) => { if (!active) return; setReport(result); if (baseline !== (result.baseline ?? "")) setBaseline(result.baseline ?? ""); if (!result.baseline && useBaseline) setUseBaseline(false); setNotice(""); }).catch((error: Error) => { if (active) setNotice(error.message); }); return () => { active = false; }; }, [query]);
  useEffect(() => { let active = true; setContests([]); setContestError(""); if (discordEnabled) void api<{ contests: Contest[] }>("/discord/contests").then((review) => { if (active) setContests(review.contests.filter((item) => item.status === "open")); }).catch((error: Error) => { if (active) setContestError(error.message); }); return () => { active = false; }; }, [query, discordEnabled]);
  function updateFilter(action: () => void) { setPage(1); action(); }
  const points = latestTrendPoints(report?.insights.trend ?? [], Number(range));
  async function resolveContest(resolution: "approved" | "rejected" | "reviewed") { if (!reviewing) return; const note = reviewNote.trim(); if (!note) { setReviewError("A review reason is required."); return; } setReviewBusy(true); try { await api("/discord/contests/resolve", { method: "POST", body: JSON.stringify({ meetingId: reviewing.meetingId, memberId: reviewing.memberId, resolution, reviewNote: note }) }); setReviewing(undefined); setReviewNote(""); setContests((current) => current.filter((item) => item !== reviewing)); setNotice(`Contest ${resolution}.`); } catch (error) { setReviewError((error as Error).message); } finally { setReviewBusy(false); } }
  return <>
    {notice && <p className="setup-status" role="status">{notice}</p>}
    {contestError && <p className="setup-status" role="status">Contest review unavailable: {contestError}</p>}
    <section className="task-card report-filters ui-card" data-walkthrough="reports-filters" aria-labelledby="leaderboard-controls-title"><div className="report-filter-heading"><InfoHeading id="leaderboard-controls-title" info="Choose the period, meetings, roster, and label membership used by the fixed attendance leaderboard.">Leaderboard controls</InfoHeading><span className="ui-status" data-tone="neutral">{report?.pagination.totalRows ?? 0} members</span></div><div className="report-filter-controls"><label>Reporting period<select value={useBaseline ? "baseline" : "custom"} onChange={(event) => updateFilter(() => setUseBaseline(event.target.value === "baseline"))}><option value="baseline" disabled={!report?.baseline}>Operational baseline{report?.baseline ? ` (${report.baseline})` : " unavailable"}</option><option value="custom">All history / fixed dates</option></select></label><label>From<input type="date" value={useBaseline ? report?.baseline ?? "" : from} disabled={useBaseline} onChange={(event) => updateFilter(() => setFrom(event.target.value))} /></label><label>To<input type="date" value={to} onChange={(event) => updateFilter(() => setTo(event.target.value))} /></label><label>Meeting type<select value={meetingType} onChange={(event) => updateFilter(() => setMeetingType(event.target.value as typeof meetingType))}><option value="all">All meetings</option><option value="required">Required meetings</option><option value="optional">Optional meetings</option></select></label><label>Roster<select value={roster} onChange={(event) => updateFilter(() => setRoster(event.target.value as typeof roster))}><option value="active">Active roster</option><option value="all">Complete history</option></select></label><label>Label group<select value={labelId} onChange={(event) => updateFilter(() => setLabelId(event.target.value))}><option value="">All labels</option>{report?.labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label><label>Membership<select value={membership} disabled={!labelId} onChange={(event) => updateFilter(() => setMembership(event.target.value as typeof membership))}><option value="current">Current</option><option value="historical">Historical</option></select></label></div></section>
    {(report?.insights.policyAlerts.length ?? 0) > 0 && <section className="task-card policy-alerts-card ui-card" aria-labelledby="policy-alerts-title"><div className="panel-heading"><h2 id="policy-alerts-title">Below attendance requirement</h2><span className="ui-status" data-tone="warning">{report!.insights.policyAlerts.length}</span></div><ul className="report-policy-alerts">{report!.insights.policyAlerts.slice(0, 10).map((item) => <li key={item.key}><RouteLink href={`/roster/${encodeURIComponent(item.memberId)}`} currentPath={path} navigate={navigate}><strong>{item.name}</strong></RouteLink><span>{policyResultText(item.policy)}</span></li>)}</ul></section>}
    <section className="report-grid"><article className="task-card leaderboard-card ui-card" data-walkthrough="reports-results"><div className="panel-heading leaderboard-heading"><InfoHeading info="Regular attendance follows these filters. Assigned policy results retain their official windows.">Attendance leaderboard</InfoHeading><label className="leaderboard-sort"><svg className="leaderboard-sort-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M7 4v16m0-16L3 8m4-4 4 4m6 12V4m0 16-4-4m4 4 4-4" /></svg><select aria-label="Sort attendance leaderboard" value={sort} onChange={(event) => updateFilter(() => setSort(event.target.value as typeof sort))}><option value="regular-desc">Regular attendance</option><option value="first-name">First name</option><option value="last-name">Last name</option></select></label></div><div className="report-table-scroll"><div className="report-table compact-leaderboard" role="table" aria-label="Attendance leaderboard"><div className="report-row header" role="row"><span role="columnheader">Member</span><span role="columnheader">Regular attendance</span></div>{report?.members.map((item) => <div className="report-row" role="row" key={item.member.id}><span role="cell"><RouteLink href={`/roster/${encodeURIComponent(item.member.memberId)}`} currentPath={path} navigate={navigate}>{item.member.firstName} {item.member.lastName}</RouteLink></span><span role="cell">{attendanceRateText(item.regularAttendance.rate)}</span></div>)}{!report?.members.length && <p className="empty-state">No attendance records match these filters.</p>}</div></div><Pagination pagination={report?.pagination} page={page} pageSize={pageSize} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></article>
      <article className="task-card trend-card ui-card" data-walkthrough="reports-trend"><div className="panel-heading"><InfoHeading info="Weighted regular attendance at each completed required meeting.">Team regular attendance trend</InfoHeading><label>Meetings<select value={range} onChange={(event) => setRange(event.target.value)}><option value="5">Last 5</option><option value="10">Last 10</option><option value="20">Last 20</option></select></label></div>{points.length ? <AttendanceTrendChart points={points} timeZone={report?.timeZone} /> : <p className="empty-state">No completed meetings match these filters.</p>}</article>
      {contests.length > 0 && <article className="task-card contest-report"><div className="panel-heading"><h2>Contests awaiting review</h2><span className="progress-count">{contests.length} open</span></div><div className="contest-list">{contests.map((contest) => <article key={`${contest.meetingId}:${contest.memberId}`}><strong>{contest.firstName} {contest.lastName}</strong><span>{contest.meetingTitle}</span><small>Submitted {new Date(contest.createdAt).toLocaleString()}</small><button type="button" onClick={() => { setReviewing(contest); setReviewNote(""); setReviewError(""); }}>Review contest</button></article>)}</div></article>}
    </section>
    {reviewing && <section className="task-card contest-review" aria-labelledby="contest-review-title"><div className="panel-heading"><div><h2 id="contest-review-title">Review contest</h2><p>{reviewing.firstName} {reviewing.lastName} · {reviewing.meetingTitle}</p></div><button type="button" onClick={() => setReviewing(undefined)} disabled={reviewBusy}>Close</button></div><label>Review reason<textarea value={reviewNote} maxLength={500} required aria-invalid={Boolean(reviewError)} aria-describedby={reviewError ? "contest-review-error" : undefined} onChange={(event) => { setReviewNote(event.target.value); setReviewError(""); }} /></label>{reviewError && <p id="contest-review-error" className="inline-messages error" role="alert">{reviewError}</p>}<div className="report-actions"><button type="button" disabled={reviewBusy} onClick={() => void resolveContest("reviewed")}>Keep attendance</button><button type="button" disabled={reviewBusy} onClick={() => void resolveContest("rejected")}>Reject contest</button><button className="primary-button" type="button" disabled={reviewBusy} onClick={() => void resolveContest("approved")}>Approve and mark present</button></div></section>}
  </>;
}

function Pagination({ pagination, page, pageSize, onPage, onPageSize, pending = false, unavailable = false }: { pagination?: ReportQueryResult["pagination"]; pending?: boolean; unavailable?: boolean; page: number; pageSize: 25 | 50 | 100 | "all"; onPage: (page: number) => void; onPageSize: (size: 25 | 50 | 100 | "all") => void }) {
  return <div className="report-pagination"><span>{pending ? "Refreshing…" : unavailable ? "Rows unavailable" : pagination?.totalRows ? `${pagination.rangeStart}-${pagination.rangeEnd} of ${pagination.totalRows}` : "0 rows"}</span><label>Rows per page<select value={String(pageSize)} onChange={(event) => onPageSize(event.target.value === "all" ? "all" : Number(event.target.value) as 25 | 50 | 100)}><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="all">All</option></select></label><button className="ui-button" type="button" disabled={pending || unavailable || page <= 1} onClick={() => onPage(page - 1)}>Previous</button><button className="ui-button" type="button" disabled={pending || unavailable || !pagination || page >= pagination.totalPages} onClick={() => onPage(page + 1)}>Next</button></div>;
}

function reportDefinitionForDataset(catalog: ReportCatalog, datasetId: string, current = catalog.defaultDefinition): ReportDefinition {
  const dataset = reportDisplayDataset(catalog, datasetId);
  const column = (key: string) => { const unit = dataset.fields.find((field) => field.id === key)?.defaultDurationUnit; return unit ? { key, unit } : { key }; };
  return { ...cloneReportDefinition(current), version: 2, dataset: dataset.id, groupBy: [...dataset.groupBy], period: dataset.filters.includes("period") ? current.period : { type: "all" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", outreachLabelIds: [], outreachLabelMatch: "any", membership: "current", columns: dataset.defaultColumns.filter((key) => dataset.fields.find((field) => field.id === key)?.available !== false).map(column), columnFilters: [], sort: { column: column(dataset.defaultSort.field), direction: dataset.defaultSort.direction } };
}

function ReportStart({ catalog, onCreate }: { catalog: ReportCatalog; onCreate: (definition: ReportDefinition) => void }) {
  return <section className="task-card ui-card report-builder" aria-labelledby="report-start-title"><div className="panel-heading"><div><h2 id="report-start-title">Build a report</h2><p>Choose the row type that answers your question. Saved views keep their dataset, columns, filters, and sort order.</p></div></div><div className="report-dataset-cards">{reportTypes(catalog).filter((dataset) => dataset.available).map((dataset) => <article key={dataset.id}><div><h3>{dataset.label}</h3><p>{dataset.description}</p></div><button className="ui-button ui-button--primary" type="button" onClick={() => onCreate(reportDefinitionForDataset(catalog, dataset.id))}>Create report</button></article>)}</div></section>;
}

function definitionForDashboard(definition: ReportDefinition, catalog: ReportCatalog) {
  const next = cloneReportDefinition(definition); const dataset = catalog.datasets.find((item) => item.id === next.dataset);
  next.outreachLabelIds ??= []; next.outreachLabelMatch ??= "any";
  const normalizeColumn = (column: ReportDefinition["columns"][number]) => {
    const unit = column.unit ?? dataset?.fields.find((field) => field.id === column.key)?.defaultDurationUnit;
    return unit ? { ...column, unit } : column;
  };
  next.columns = next.columns.map(normalizeColumn);
  next.sort.column = normalizeColumn(next.sort.column);
  next.columnFilters = (next.columnFilters ?? []).map((filter) => ({ ...filter, column: normalizeColumn(filter.column) }));
  return next;
}

function periodText(period: ReportDefinition["period"], baseline: string | null) {
  if (period.type === "fixed") return `${period.from} to ${period.to}`;
  if (period.type === "all") return "All history";
  if (period.type === "baseline") return baseline ? `Operational baseline (${baseline})` : "Operational baseline";
  if (period.type === "last_days") return `Last ${period.days} days`;
  if (period.type === "current_month") return "Current month";
  return "Current year";
}


function ReportEditor({ catalog, saved, draft, pinnedIds, onDirtyChange, onLibrariesChanged, onNavigate, onTogglePin, editorRef, onSavedNavigate }: { editorRef: React.Ref<ReportEditorHandle>; catalog: ReportCatalog; saved?: SavedReport; draft?: Draft; pinnedIds: string[]; onDirtyChange: (dirty: boolean) => void; onLibrariesChanged: () => Promise<void>; onNavigate: (path: string) => void; onSavedNavigate: (path: string) => void; onTogglePin: (id: string) => Promise<void> }) {
  const sourceDefinition = saved?.definition ?? draft?.definition ?? reportDefinitionForDataset(catalog, membersDataset(catalog)?.id ?? catalog.defaultDefinition.dataset);
  const seed = { name: saved?.name ?? draft?.name ?? "Untitled report", scope: saved?.scope ?? draft?.scope ?? "personal", definition: definitionForDashboard(sourceDefinition, catalog), imported: Boolean(draft?.imported) };
  const [name, setName] = useState(seed.name), [scope, setScope] = useState<ReportScope>(seed.scope);
  const [definition, setDefinition] = useState(seed.definition), [editing, setEditing] = useState(!saved);
  const [notice, setNotice] = useState(""), [reload, setReload] = useState(0);
  const [operation, setOperation] = useState<"saving" | "exporting" | "deleting" | "pinning">();
  const pending = useRef(false), alive = useRef(true);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState<25 | 50 | 100 | "all">(25);
  const [labelSearch, setLabelSearch] = useState(""), [outreachLabelSearch, setOutreachLabelSearch] = useState("");
  const original = useRef({ ...seed, definition: cloneReportDefinition(seed.definition), revision: saved?.revision });
  const dirty = name !== original.current.name || scope !== original.current.scope || !sameReportDefinition(definition, original.current.definition);
  const busy = operation !== undefined;
  const queryKey = JSON.stringify({ definition, page, pageSize });
  const [response, setResponse] = useState<{ key: string; data?: ReportQueryResult; error?: string }>();
  const visibleResult = response?.key === queryKey ? response.data : undefined;
  const queryError = response?.key === queryKey ? response.error : undefined;
  const loading = response?.key !== queryKey;
  const invalidPeriod = definition.period.type === "fixed" && (!definition.period.from || !definition.period.to || definition.period.from > definition.period.to);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onDirtyChange(!saved || dirty); if (!saved) saveDraft({ name, scope, definition, imported: seed.imported }); }, [editing, dirty, name, scope, definition, saved]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (saved && !dirty) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [saved, dirty]);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    if (invalidPeriod) { setResponse({ key: queryKey, error: "Choose valid start and end dates, with the end on or after the start." }); return; }
    const timer = window.setTimeout(() => {
      void api<ReportQueryResult>("/reports/query", { method: "POST", signal: controller.signal, body: queryKey })
        .then((data) => { if (current) setResponse({ key: queryKey, data }); })
        .catch((error: Error) => { if (current && error.name !== "AbortError") setResponse({ key: queryKey, error: error.message }); });
    }, 300);
    return () => { current = false; window.clearTimeout(timer); controller.abort(); };
  }, [queryKey, invalidPeriod, reload]);
  function change(mutator: (next: ReportDefinition) => void) {
    if (pending.current) return;
    setPage(1);
    setDefinition((current) => { const next = cloneReportDefinition(current); useMemberFields(next, catalog); mutator(next); return next; });
  }
  const labels = catalog.labels.filter((label) => label.name.toLowerCase().includes(labelSearch.toLowerCase()));
  const labelNames = new Map(catalog.labels.map((label) => [label.id, label.name]));
  const missingLabelIds = definition.labelIds.filter((id) => !labelNames.has(id));
  const outreachLabels = catalog.outreachLabels.filter((label) => label.name.toLowerCase().includes(outreachLabelSearch.toLowerCase()));
  const outreachLabelNames = new Map(catalog.outreachLabels.map((label) => [label.id, label.name]));
  const missingOutreachLabelIds = definition.outreachLabelIds.filter((id) => !outreachLabelNames.has(id));
  const columnName = (column: ReportDefinition["columns"][number]) => {
    const item = catalog.columns.find((candidate) => candidate.key === column.key);
    const base = item?.durationUnits ? reportColumnLabel(column, item.label) : item?.label ?? column.key;
    return column.labelId ? (labelNames.get(column.labelId) ?? "Unavailable label") + " - " + base : base;
  };
  const dataset = reportDisplayDataset(catalog, definition.dataset);
  const supports = new Set(dataset.filters);
  const exportPaused = !dataset.available || visibleResult?.state === "paused";
  const searchColumn = definition.columns[0];
  const searchAvailable = dataset.fields.some((field) => field.id === searchColumn.key && field.available !== false && field.filterOperators.includes("contains"));
  const searchValue = definition.columnFilters?.find((filter) => reportColumnId(filter.column) === reportColumnId(searchColumn) && filter.operator === "contains")?.value ?? "";
  function resetView() { setDefinition(cloneReportDefinition(original.current.definition)); setPage(1); setNotice(""); }
  function cancelEdit() { setName(original.current.name); setScope(original.current.scope); resetView(); setEditing(false); onDirtyChange(false); }
  function startOperation(next: NonNullable<typeof operation>) { if (pending.current) return false; pending.current = true; setOperation(next); setNotice(""); return true; }
  function finishOperation() { pending.current = false; if (alive.current) setOperation(undefined); }
  useImperativeHandle(editorRef, () => ({ save: () => save(false, false) }));
  async function save(copy = false, navigateAfter = true): Promise<ReportSaveResult> {
    if (pending.current) return { ok: false, error: "Wait for the current report action to finish." };
    let saveName = name;
    if (copy) { const requested = window.prompt("Name for the copied report", name + " copy"); if (!requested?.trim()) return { ok: false }; saveName = requested.trim(); }
    if (!saveName.trim() || invalidPeriod) { const error = !saveName.trim() ? "Enter a report name before saving." : "Choose a valid report date range before saving."; setNotice(error); return { ok: false, error }; }
    if (!startOperation("saving")) return { ok: false };
    try {
      const created = copy || !saved;
      const { report } = await api<{ report: SavedReport }>(created ? "/reports/views" : "/reports/views/" + encodeURIComponent(saved.id), { method: created ? "POST" : "PATCH", body: JSON.stringify({ name: saveName, scope, definition, ...(created ? {} : { revision: original.current.revision }) }) });
      if (!alive.current) return { ok: false };
      if (seed.imported) localStorage.removeItem(legacyViewKey);
      const nextDefinition = definitionForDashboard(report.definition, catalog);
      setName(report.name); setScope(report.scope); setDefinition(nextDefinition);
      original.current = { name: report.name, scope: report.scope, definition: cloneReportDefinition(nextDefinition), revision: report.revision, imported: false };
      setEditing(false); onDirtyChange(false); setNotice("");
      try { await onLibrariesChanged(); } catch { setNotice("Report saved. Reload the page to refresh the report library."); }
      if (alive.current) { sessionStorage.removeItem(draftKey); if (navigateAfter) onSavedNavigate("/reports/view/" + encodeURIComponent(report.id)); }
      return { ok: true };
    } catch (error) { const message = (error as Error).message + (!saved || copy ? " Check Browse reports before trying to save again." : ""); if (alive.current) setNotice(message); return { ok: false, error: message }; }
    finally { finishOperation(); }
  }
  async function remove() {
    if (!saved || pending.current || !window.confirm("Delete " + saved.name + "? This removes it for everyone who can access it.")) return;
    if (!startOperation("deleting")) return;
    try { await api("/reports/views/" + encodeURIComponent(saved.id) + "?revision=" + original.current.revision, { method: "DELETE" }); onDirtyChange(false); await onLibrariesChanged(); if (alive.current) onSavedNavigate("/reports"); }
    catch (error) { if (alive.current) setNotice((error as Error).message); }
    finally { finishOperation(); }
  }
  async function download(detail: boolean) {
    if (loading || queryError || exportPaused || !startOperation("exporting")) return;
    try {
      const response = await fetch(apiBaseUrl + (detail ? "/exports/report-detail.csv" : "/exports/report.csv"), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? "CSV export failed"); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = reportExportFilename(name, detail); link.click(); URL.revokeObjectURL(url);
      if (alive.current) setNotice("CSV downloaded for all matching rows using the current filters.");
    } catch (error) { if (alive.current) setNotice((error as Error).message); }
    finally { finishOperation(); }
  }
  async function togglePin() { if (!saved || !startOperation("pinning")) return; try { await onTogglePin(saved.id); } finally { finishOperation(); } }
  const chips: { key: string; text: string; clear: (next: ReportDefinition) => void }[] = [];
  if (supports.has("period") && definition.period.type !== "all") chips.push({ key: "period", text: periodText(definition.period, catalog.baseline), clear: (next) => { next.period = { type: "all" }; } });
  if (supports.has("roster") && definition.roster === "active") chips.push({ key: "roster", text: "Active members", clear: (next) => { next.roster = "all"; } });
  if (supports.has("meeting-type") && definition.meetingType !== "all") chips.push({ key: "meetings", text: definition.meetingType === "required" ? "Required meetings" : "Optional meetings", clear: (next) => { next.meetingType = "all"; } });
  if (definition.labelIds.length) chips.push({ key: "labels", text: "Labels (" + definition.labelMatch + "): " + definition.labelIds.map((id) => labelNames.get(id) ?? "Unavailable label").join(", "), clear: (next) => { next.labelIds = []; } });
  if (definition.outreachLabelIds.length) chips.push({ key: "outreach-labels", text: "Outreach labels (" + definition.outreachLabelMatch + "): " + definition.outreachLabelIds.map((id) => outreachLabelNames.get(id) ?? "Unavailable Outreach label").join(", "), clear: (next) => { next.outreachLabelIds = []; } });
  for (const filter of definition.columnFilters ?? []) chips.push({ key: "column-" + reportColumnId(filter.column), text: columnName(filter.column) + (filter.operator === "minimum" ? " at least " : " contains ") + filter.value, clear: (next) => { next.columnFilters = next.columnFilters?.filter((item) => reportColumnId(item.column) !== reportColumnId(filter.column)); } });
  const filterControls = <><fieldset className="report-filter-fields"><legend>Filter records</legend><div className="report-filter-controls">{supports.has("period") && <><label>Period<select value={definition.period.type === "last_days" ? `last_${definition.period.days}` : definition.period.type} onChange={(event) => change((next) => { const value = event.target.value; next.period = value.startsWith("last_") ? { type: "last_days", days: Number(value.slice(5)) as 7 | 30 | 60 | 90 } : value === "fixed" ? { type: "fixed", from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } : { type: value as "all" | "baseline" | "current_month" | "current_year" }; })}><option value="all">All history</option><option value="baseline" disabled={!catalog.baseline}>Operational baseline</option><option value="last_7">Last 7 days</option><option value="last_30">Last 30 days</option><option value="last_60">Last 60 days</option><option value="last_90">Last 90 days</option><option value="current_month">Current month</option><option value="current_year">Current year</option><option value="fixed">Custom fixed range</option></select></label>{definition.period.type === "fixed" && <><label>From<input type="date" aria-invalid={invalidPeriod || undefined} aria-describedby={invalidPeriod ? "report-date-error" : undefined} value={definition.period.from} onChange={(event) => change((next) => { if (next.period.type === "fixed") next.period.from = event.target.value; })} /></label><label>To<input type="date" min={definition.period.from} aria-invalid={invalidPeriod || undefined} aria-describedby={invalidPeriod ? "report-date-error" : undefined} value={definition.period.to} onChange={(event) => change((next) => { if (next.period.type === "fixed") next.period.to = event.target.value; })} /></label></>}</>}{supports.has("roster") && <label>Roster<select value={definition.roster} onChange={(event) => change((next) => { next.roster = event.target.value as ReportDefinition["roster"]; })}><option value="active">Active members</option><option value="all">All members</option></select></label>}{supports.has("meeting-type") && <label>Meetings<select value={definition.meetingType} onChange={(event) => change((next) => { next.meetingType = event.target.value as ReportDefinition["meetingType"]; })}><option value="all">All meetings</option><option value="required">Required</option><option value="optional">Optional</option></select></label>}{supports.has("labels") && <label>Label matching<select value={definition.labelMatch} disabled={!definition.labelIds.length} onChange={(event) => change((next) => { next.labelMatch = event.target.value as ReportDefinition["labelMatch"]; })}><option value="any">Any selected label</option><option value="all">All selected labels</option></select></label>}{supports.has("outreach-labels") && <label>Outreach label matching<select value={definition.outreachLabelMatch} disabled={!definition.outreachLabelIds.length} onChange={(event) => change((next) => { next.outreachLabelMatch = event.target.value as ReportDefinition["outreachLabelMatch"]; })}><option value="any">Any selected label</option><option value="all">All selected labels</option></select></label>}{supports.has("membership") && <label>Membership<select value={definition.membership} aria-describedby="report-membership-help" onChange={(event) => change((next) => { next.membership = event.target.value as ReportDefinition["membership"]; })}><option value="current">Current membership</option><option value="historical">Historical membership</option></select></label>}</div>{supports.has("labels") && <MultiPicker title={`Labels (${definition.labelIds.length || "all"})`} searchLabel="Search labels" search={labelSearch} onSearch={setLabelSearch}>{missingLabelIds.map((id) => <label key={id}><input type="checkbox" checked onChange={() => change((next) => { next.labelIds = next.labelIds.filter((labelId) => labelId !== id); })} />Unavailable label <small>Remove to save</small></label>)}{labels.map((label) => <label key={label.id}><input type="checkbox" checked={definition.labelIds.includes(label.id)} onChange={(event) => change((next) => { if (event.target.checked && next.labelIds.length >= 25) { setNotice("A report can filter by at most 25 labels."); return; } next.labelIds = event.target.checked ? [...next.labelIds, label.id] : next.labelIds.filter((id) => id !== label.id); })} />{label.name}{!label.active && <small>Retired</small>}</label>)}</MultiPicker>}{supports.has("outreach-labels") && <MultiPicker title={`Outreach labels (${definition.outreachLabelIds.length || "all"})`} searchLabel="Search Outreach labels" search={outreachLabelSearch} onSearch={setOutreachLabelSearch}>{missingOutreachLabelIds.map((id) => <label key={id}><input type="checkbox" checked onChange={() => change((next) => { next.outreachLabelIds = next.outreachLabelIds.filter((labelId) => labelId !== id); })} />Unavailable Outreach label <small>Remove to save</small></label>)}{outreachLabels.map((label) => <label key={label.id}><input type="checkbox" checked={definition.outreachLabelIds.includes(label.id)} onChange={(event) => change((next) => { if (event.target.checked && next.outreachLabelIds.length >= 25) { setNotice("A report can filter by at most 25 Outreach labels."); return; } next.outreachLabelIds = event.target.checked ? [...next.outreachLabelIds, label.id] : next.outreachLabelIds.filter((id) => id !== label.id); })} />{label.name}{label.archived && <small>Archived</small>}</label>)}</MultiPicker>}</fieldset>
    {invalidPeriod && <p id="report-date-error" className="ui-status" data-tone="error">Choose an end date on or after the start date.</p>}
    {supports.has("membership") && <p id="report-membership-help" className="report-field-help">{definition.membership === "current" ? "Current membership applies today’s labels throughout the report period." : "Historical membership uses labels held on each meeting date."} Official policy columns keep their configured membership and dates.</p>}
  </>;
  return <section className="saved-report-workspace" aria-labelledby="saved-report-title" aria-busy={busy}>
    <section className="task-card ui-card report-builder" data-walkthrough="report-builder">
      <div className="report-builder-heading">
        <div><h2 id="saved-report-title">{saved ? saved.name : "New report"}</h2><p className="report-compact-scope">{dataset.label}{supports.has("period") ? " · " + periodText(definition.period, catalog.baseline) : ""}{supports.has("roster") ? " · " + (definition.roster === "active" ? "Active members" : "All members") : ""}</p></div>
        <div className="report-builder-heading-actions"><span className="ui-status" data-tone="neutral">{scope}</span>{saved && !editing && <button className="ui-button report-icon-button" type="button" disabled={busy} onClick={() => setEditing(true)}><svg className="report-action-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5" /></svg><span>Edit</span></button>}</div>
      </div>
      {!dataset.available && <p className="ui-status" data-tone="warning">This dataset is unavailable for your current module access. Its definition remains editable, while results and exports stay paused.</p>}
      {saved?.warnings.map((warning) => <p className="ui-status" data-tone="warning" key={warning}>{warning}</p>)}
      {editing ? <details className="report-settings-details report-edit-settings" open><summary><span>Report settings</span><ReportChevron /></summary><fieldset className="report-edit-fields" disabled={busy}><legend className="visually-hidden">Report settings</legend><div className="report-builder-identity"><label>Report name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label><label>Report type<select aria-label="Report type" aria-describedby="report-dataset-help" value={dataset.id} onChange={(event) => { setPage(1); setDefinition((current) => reportDefinitionForDataset(catalog, event.target.value, current)); }}>{reportTypes(catalog).map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? "" : " - unavailable"}</option>)}</select></label><label>Visibility<select value={scope} onChange={(event) => setScope(event.target.value as ReportScope)}><option value="personal">Personal</option><option value="shared">Shared</option></select></label></div><p id="report-dataset-help" className="report-field-help">{dataset.description}</p><p className="report-field-help">{scope === "shared" ? "Administrators and operators can view and edit this shared report. Results still follow each account’s module access." : "Only you can access this personal report."}</p>{saved && filterControls}</fieldset></details> : <details className="report-settings-details"><summary><span>Filters and report settings</span><ReportChevron /></summary><fieldset className="report-edit-fields" disabled={busy}><legend className="visually-hidden">Report filters</legend>{filterControls}</fieldset><dl className="report-settings-summary"><div><dt>Columns</dt><dd>{definition.columns.map(columnName).join(", ")}</dd></div><div><dt>Sort</dt><dd>{columnName(definition.sort.column)} ({definition.sort.direction === "asc" ? "ascending" : "descending"})</dd></div><div><dt>Visibility</dt><dd>{scope === "shared" ? "Administrators and operators can view and edit this report. Results follow module access." : "Only you can access this report."}</dd></div></dl></details>}
      <div className="report-control-actions" data-walkthrough="report-actions">
        {editing && <button className="ui-button ui-button--primary" type="button" disabled={busy || !name.trim() || Boolean(saved && !dirty)} onClick={() => void save()}>{operation === "saving" ? "Saving…" : "Save"}</button>}
        {saved && editing && <button className="ui-button" type="button" disabled={busy} onClick={cancelEdit}>Cancel</button>}
        {saved && !editing && dirty && <><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void save()}>{operation === "saving" ? "Saving…" : "Save view"}</button><button className="ui-button" type="button" disabled={busy} onClick={resetView}>Reset view</button></>}
        {(!saved || dirty) && <span className="ui-status report-state-pill" data-tone="warning" role="status">{!saved ? "DRAFT" : "UNSAVED CHANGES"}</span>}
        {operation && <span className="report-view-state" role="status">{operation === "saving" ? "Saving…" : operation === "exporting" ? "Exporting…" : operation === "deleting" ? "Deleting report…" : "Updating pin…"}</span>}
        {saved && scope === "shared" && dirty && <span className="report-field-help">Saving updates the shared report for everyone.</span>}
        {saved && <ReportMenu label="Report actions"><button className="ui-button" type="button" disabled={busy} onClick={() => void save(true)}>Save as copy</button><button className="ui-button" type="button" disabled={busy} onClick={() => void togglePin()}>{pinnedIds.includes(saved.id) ? "Unpin report" : "Pin report"}</button><button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => void remove()}>Delete report</button></ReportMenu>}
      </div>
      {notice && <p className="setup-status" role="status">{notice}</p>}
    </section>
    <section className="task-card ui-card report-results" data-walkthrough="reports-results" aria-labelledby="report-results-title" aria-busy={loading}>
      <div className="panel-heading"><div><h2 id="report-results-title">Results</h2><p role="status">{loading ? "Refreshing…" : visibleResult?.state === "paused" ? "Paused" : visibleResult ? visibleResult.pagination.totalRows + " matching rows" : "Results unavailable"}</p>{supports.has("period") && definition.period.type !== "all" && visibleResult?.resolvedPeriod.from && <p className="report-resolved-period">{visibleResult.resolvedPeriod.from} - {visibleResult.resolvedPeriod.to}</p>}</div></div>
      {saved && <div className="report-filter-chips" aria-label="Applied report filters">{chips.map((chip) => <button className="ui-button report-filter-chip" type="button" key={chip.key} disabled={busy} aria-label={"Remove filter: " + chip.text} onClick={() => change(chip.clear)}>{chip.text}<span aria-hidden="true">×</span></button>)}{chips.length > 0 && <button className="ui-button" type="button" disabled={busy} onClick={() => change((next) => { next.period = { type: "all" }; next.roster = "all"; next.meetingType = "all"; next.labelIds = []; next.outreachLabelIds = []; next.columnFilters = []; })}>Clear filters</button>}</div>}
      {queryError && <p className="ui-status" data-tone="error" role="alert">{queryError} Previous results are hidden. <button className="ui-button" type="button" onClick={() => { setResponse(undefined); setReload((value) => value + 1); }}>Retry report</button></p>}
      {visibleResult?.pausedReasons?.map((reason) => <p className="ui-status report-paused-notice" data-tone="warning" role="status" key={reason}>{reason} The definition and its controls have been preserved.</p>)}
      {visibleResult?.warnings.map((warning) => <p className="ui-status" data-tone="warning" key={warning}>{warning}</p>)}
      <EditableReportTable catalog={catalog} definition={definition} result={visibleResult} loading={loading || Boolean(queryError)} editable={!busy} filterable={Boolean(saved)} onChange={change} onNavigate={onNavigate} onNotice={setNotice} toolbar={<>
        {saved && searchAvailable && <label className="report-results-search">Search {columnName(searchColumn).toLowerCase()}<input className="ui-control" type="search" aria-label="Search report results" value={searchValue} disabled={busy} placeholder={"Search " + columnName(searchColumn).toLowerCase()} onChange={(event) => change((next) => { const remaining = (next.columnFilters ?? []).filter((filter) => reportColumnId(filter.column) !== reportColumnId(searchColumn)); next.columnFilters = event.target.value ? [...remaining, { column: searchColumn, operator: "contains", value: event.target.value }] : remaining; })} /></label>}
        <ReportMenu label={operation === "exporting" ? "Exporting…" : "Export"} icon={<svg className="report-menu-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" /></svg>}><p>Exports include all matching rows using the current filters{dirty ? ", including unsaved changes" : ""}.</p><button className="ui-button" type="button" disabled={busy || loading || Boolean(queryError) || exportPaused} aria-label="Download report CSV" onClick={() => void download(false)}>Download report CSV<small>Selected columns and current sort order</small></button>{isMemberReport(catalog, definition.dataset) && catalog.attendanceAvailable && <button className="ui-button" type="button" disabled={busy || loading || Boolean(queryError) || exportPaused} aria-label="Download detailed attendance CSV" onClick={() => void download(true)}>Download detailed attendance CSV<small>Meeting-level attendance records for this report</small></button>}{exportPaused && <p>Export is paused while a controlling report source is unavailable.</p>}</ReportMenu>
      </>} />
      <Pagination pagination={visibleResult?.pagination} page={page} pageSize={pageSize} pending={loading} unavailable={!visibleResult || visibleResult.state === "paused"} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />
    </section>
  </section>;
}

function ReportChevron() { return <svg className="report-disclosure-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" /></svg>; }

function ReportMenu({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  const details = useRef<HTMLDetailsElement | null>(null);
  useDismissableDetails(details);
  return <details className={`report-menu${icon ? " report-menu--icon" : ""}`} ref={details}><summary><span>{label}</span>{icon ?? <ReportChevron />}</summary><div className="report-menu-panel" onClick={(event) => { if ((event.target as Element).closest("button:not(:disabled)") && details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } }}>{children}</div></details>;
}

function MultiPicker({ title, searchLabel, search, onSearch, children }: { title: string; searchLabel: string; search: string; onSearch: (value: string) => void; children: React.ReactNode }) { const details = useRef<HTMLDetailsElement | null>(null); useDismissableDetails(details); return <details ref={details} className="multi-picker"><summary>{title}</summary><div><input type="search" aria-label={searchLabel} placeholder={searchLabel} value={search} onChange={(event) => onSearch(event.target.value)} />{children}</div></details>; }
