import { ReportColumnFilterControl } from "./report-column-filter";
import { ColumnIcon, ReportChoiceFilter, ReportFilterActions, ReportFilterChoiceList, ReportFilterPicker, ReportOptionFilter, ReportPopover, ReportPopoverHeading, reportFilterTargetKey, type ReportFilterPickerItem, type ReportFilterTarget } from "./report-filter-popover";
import "./mobile-roster-reports.css";
import { isMemberReport, membersDataset, reportDisplayDataset, reportTypes, useMemberFields } from "./member-report-types";
import { ReportLeaveDialog, type ReportEditorHandle, type ReportSaveResult } from "./report-leave-dialog";
import { countText, installationToday, lastMonthRange, latestTrendPoints, reportColumnFilterText, reportExportFilename, reportPeriodChoice, reportPeriodFromChoice, reportPeriodOptions } from "./report-view";
import { baselinePeriodText, baselineStarted as reportBaselineStarted, combinedBaselineChoices, definitionBaseline } from "./report-baselines";
import { AttendanceTrendChart } from "./attendance-trend-chart";
import { PageWalkthroughExperience } from "./page-walkthrough";
import { pageWalkthroughForPath } from "./page-walkthrough-definitions";
import { exampleReportDefinition, exampleReportName } from "./report-template";
import { attendanceByLabelDefinition, attendanceByLabelPreset, attendanceByLabelSummary, presetPeriodOptions } from "./report-presets";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, apiBaseUrl } from "./dashboard-api";
import { RouteLink, routeWillChangeEvent, usePath } from "./router";
import { useDashboardLoadingOverlay } from "./loading-overlay";
import { removeStorage, saveBlob, writeStorage } from "./browser-storage";
import { policyResultText, reportQuery, type AttendanceReport, type ReportFilters } from "./report-attendance";
import { CalcTip, CalcTipContent, InfoHeading } from "./info-tip";
import { attendanceStatusText } from "../../../packages/shared/src/attendance-terms.ts";
import { labelPolicyText, labelRateTip, leaderboardTip, overallRateTip, rateText, statusTone, type LabelPolicySummary } from "../../../packages/shared/src/attendance-label-sets.ts";
import { EditableReportTable, NoValue } from "./report-result-table";
import { cloneReportDefinition, emptyModuleFilterSelections, moduleFilterSelection, reportColumnId, reportColumnLabel, sameReportDefinition, type ReportCatalog, type ReportColumn, type ReportColumnFilter, type ReportDataset, type ReportDefinition, type ReportModuleFilter, type ReportQueryResult, type ReportScope, type SavedReport } from "./saved-reports";

type Contest = { meetingId: string; memberId: string; firstName: string; lastName: string; meetingTitle: string; status: "open" | "approved" | "rejected" | "reviewed"; createdAt: string };
type LegacyView = { from?: string; to?: string; meetingType?: "all" | "required" | "optional"; roster?: "active" | "all"; labelId?: string; membership?: "current" | "historical"; useBaseline?: boolean };
/** + Filter's drill-in for fields that need a label: a field, then its label. */
type LabelFieldView = { kind: "label-fields" } | { kind: "label-field"; key: string };
type FilterView = "picker" | "period" | ReportFilterTarget | LabelFieldView;
type Draft = { name: string; scope: ReportScope; definition: ReportDefinition; imported?: boolean };
const legacyViewKey = "lancerlogin-reports-view";
const draftKey = "lancerlogin-report-draft-v1";
function storedDraft(): Draft | undefined { try { return JSON.parse(sessionStorage.getItem(draftKey) ?? "") as Draft; } catch { return undefined; } }
function saveDraft(draft: Draft) { writeStorage("session", draftKey, JSON.stringify(draft)); }
// Stored and API scope values stay "personal" and "shared"; the dashboard calls a personal report private.
const reportScopeLabel = (scope: ReportScope) => scope === "personal" ? "private" : "shared";
function directReportId(path: string) { if (!path.startsWith("/reports/view/")) return undefined; try { return decodeURIComponent(path.slice("/reports/view/".length)); } catch { return undefined; } }

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
  function finishLeave(next: string) { if (path === "/reports/new") removeStorage("session", draftKey); allowNextRoute.current = true; setDirty(false); navigate(next); }
  function leave(next: string) { if (next !== path) requestLeave(() => finishLeave(next)); }
  // A confirmed delete leaves at once: its edits are gone with the report, so nothing asks to save them, and a slow or
  // failed library refresh can no longer strand the editor on a report that no longer exists.
  function finishDelete(id: string) {
    setPendingLeave(undefined); setReports((current) => current.filter((item) => item.id !== id)); finishLeave("/reports");
    void loadLibraries().catch(() => { if (mounted.current) setNotice("Report deleted. Reload the page to refresh the report library."); });
  }
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
  function importedDraft(): Draft | undefined { try { const legacy = JSON.parse(localStorage.getItem(legacyViewKey) ?? "") as LegacyView; if (!catalog?.attendanceAvailable) return; const period = legacy.useBaseline && catalog.baseline ? { type: "baseline" as const } : legacy.from || legacy.to ? { type: "fixed" as const, from: legacy.from || "2000-01-01", to: legacy.to || installationToday(catalog.timeZone) } : { type: "all" as const }; const attendance = catalog.datasets.find((dataset) => dataset.id === "attendance.members")!; return { name: "Imported attendance view", scope: "personal", imported: true, definition: { ...cloneReportDefinition(catalog.defaultDefinition), dataset: attendance.id, groupBy: [...attendance.groupBy], columns: attendance.defaultColumns.map((key) => ({ key })), sort: { column: { key: attendance.defaultSort.field }, direction: attendance.defaultSort.direction }, period, meetingType: legacy.meetingType ?? "all", roster: legacy.roster ?? "active", labelIds: legacy.labelId ? [legacy.labelId] : [], membership: legacy.membership ?? "current" } }; } catch { return; } }
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
    <nav className="report-tabs" data-walkthrough="reports-tabs" aria-label="Report pages">{catalog?.attendanceAvailable && <button className={path === "/reports" ? "active" : ""} type="button" onClick={() => leave("/reports")}>Leaderboard</button>}{visibleTabs.map((item) => <span className={`report-tab${reportId === item.id ? " active" : ""}`} key={item.id}><button type="button" onClick={() => leave(`/reports/view/${encodeURIComponent(item.id)}`)} aria-current={reportId === item.id ? "page" : undefined}>{item.name}</button><button className="tab-close" type="button" disabled={pinBusy} title={item.pinnedPosition === null ? "Close report" : "Unpin report"} aria-label={(item.pinnedPosition === null ? "Close " : "Unpin ") + item.name} onClick={() => item.pinnedPosition === null ? leave("/reports") : void unpin(item.id)}>×</button></span>)}<ReportBrowser browse={browse} onBrowse={setBrowse}>{legacyDraft && <div className="browse-report-row"><button type="button" onClick={() => { requestLeave(() => { finishLeave("/reports/new"); saveDraft(legacyDraft); }); }}>Imported browser view <small>Unsaved draft</small></button><button type="button" aria-label="Dismiss imported browser view" onClick={() => { removeStorage("local", legacyViewKey); setNotice("Imported browser view dismissed."); }}>×</button></div>}{available.map((item) => <div className="browse-report-row" key={item.id}><button className="ui-button" type="button" aria-current={item.id === reportId ? "page" : undefined} onClick={() => openReport(item)}>{item.name}<small>{reportScopeLabel(item.scope)}{item.id === reportId ? " · Open" : ""}{item.pinnedPosition !== null ? " · Pinned" : ""}</small></button><button className="ui-button" type="button" disabled={pinBusy} aria-label={(item.pinnedPosition === null ? "Pin " : "Unpin ") + item.name} onClick={() => void persistPins(item.pinnedPosition === null ? [...pinned.map((report) => report.id), item.id] : pinned.filter((report) => report.id !== item.id).map((report) => report.id))}>{item.pinnedPosition === null ? "Pin" : "Unpin"}</button></div>)}{!available.length && !legacyDraft && <p>No reports match.</p>}</ReportBrowser><button className="ui-button report-add-tab" type="button" onClick={() => leave("/reports/new")}>New report</button></nav>
    {!catalog ? <p className="empty-state">Report controls are unavailable.</p> : path === "/reports" ? catalog.attendanceAvailable ? <Leaderboard discordEnabled={discordEnabled} initialBaseline={catalog.baseline} labelPolicies={catalog.labelPolicies ?? []} /> : <ReportStart catalog={catalog} onCreate={(definition) => { saveDraft({ name: "Untitled report", scope: "personal", definition }); leave("/reports/new"); }} /> : path === "/reports/new" ? <ReportEditor key="new" catalog={catalog} draft={storedDraft()} pinnedIds={pinned.map((item) => item.id)} editorRef={editor} onDirtyChange={setDirty} onLibrariesChanged={loadLibraries} onNavigate={navigate} onSavedNavigate={finishLeave} onTogglePin={async (id) => { await persistPins(pinned.some((report) => report.id === id) ? pinned.filter((report) => report.id !== id).map((report) => report.id) : [...pinned.map((report) => report.id), id]); }} /> : selected ? <ReportEditor key={selected.id} catalog={catalog} saved={selected} pinnedIds={pinned.map((item) => item.id)} editorRef={editor} onDirtyChange={setDirty} onLibrariesChanged={loadLibraries} onNavigate={navigate} onSavedNavigate={finishLeave} onDeleted={finishDelete} onTogglePin={async (id) => { await persistPins(pinned.some((report) => report.id === id) ? pinned.filter((report) => report.id !== id).map((report) => report.id) : [...pinned.map((report) => report.id), id]); }} /> : reportId ? <section className="ui-card empty-page"><h2>Report unavailable</h2><p>This report was deleted or is private to another account.</p><button type="button" onClick={() => navigate("/reports")}>Return to Reports</button></section> : null}
  </section>
  {pendingLeave && <ReportLeaveDialog onSave={() => editor.current?.save() ?? Promise.resolve({ ok: false, error: "The report is unavailable. Cancel to return to Reports." })} onLeave={async () => { await pendingLeave.action(); setPendingLeave(undefined); }} onCancel={() => setPendingLeave(undefined)} />}
  {catalog?.attendanceAvailable && <PageWalkthroughExperience definition={pageWalkthroughForPath(path, catalog.role)!} debugMode={debugMode} onStateChange={onWalkthroughChange} renderStepAction={(step) => step.id === "report-builder" ? <>
    <p>Optionally add a private monthly report with member names, labels, attendance counts, and policy results. It uses your roster and stays saved after this walkthrough.</p>
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
    // A web font that finishes loading while the popup is open reflows the report tabs and moves the trigger.
    document.fonts?.addEventListener("loadingdone", updatePosition);
    return () => { window.removeEventListener("resize", updatePosition); window.removeEventListener("scroll", updatePosition, true); document.fonts?.removeEventListener("loadingdone", updatePosition); };
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

/** A member's result under the chosen label's policy, when the Leaderboard ranks by it. */
type LeaderboardLabelResult = { status: string; rate: number | null };
type LeaderboardReport = Omit<AttendanceReport, "members"> & { members: (AttendanceReport["members"][number] & { labelResult?: LeaderboardLabelResult })[]; today?: string; pagination: ReportQueryResult["pagination"]; insights: { policyAlerts: { key: string; memberId: string; name: string; policy: import("./report-attendance").ReportCompliance }[]; trend: { meetingId: string; title: string; startsAt: string; rate: number }[] } };
// A baseline after today has no completed meetings yet, so the Leaderboard falls back to all history.
const baselineStarted = (report: Pick<LeaderboardReport, "baseline" | "today">) => Boolean(report.baseline && (!report.today || report.baseline <= report.today));
function Leaderboard({ discordEnabled, initialBaseline, labelPolicies }: { discordEnabled: boolean; initialBaseline: string | null; labelPolicies: LabelPolicySummary[] }) {
  const { path, navigate } = usePath(); const [report, setReport] = useState<LeaderboardReport>(); const [contests, setContests] = useState<Contest[]>([]); const [notice, setNotice] = useState("Loading leaderboard…"); const [sort, setSort] = useState<"regular-desc" | "label-rate" | "first-name" | "last-name">("regular-desc"); const [range, setRange] = useState("10"); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [meetingType, setMeetingType] = useState<"all" | "required" | "optional">("all"); const [roster, setRoster] = useState<"active" | "all">("active"); const [labelId, setLabelId] = useState(""); const [membership, setMembership] = useState<"current" | "historical">("current"); const [baseline, setBaseline] = useState(initialBaseline ?? ""); const [useBaseline, setUseBaseline] = useState(true); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState<25 | 50 | 100 | "all">(25); const [reviewing, setReviewing] = useState<Contest>(); const [reviewNote, setReviewNote] = useState(""); const [reviewError, setReviewError] = useState(""); const [reviewBusy, setReviewBusy] = useState(false);
  const [contestError, setContestError] = useState("");
  const filters: ReportFilters = useMemo(() => ({ from: useBaseline ? baseline || undefined : from || undefined, to: to || undefined, meetingType, roster, labelId: labelId || undefined, membership }), [useBaseline, baseline, from, to, meetingType, roster, labelId, membership]);
  const query = useMemo(() => { const value = new URLSearchParams(reportQuery(filters)); value.set("sort", sort); value.set("page", String(page)); value.set("pageSize", String(pageSize)); return value.toString(); }, [filters, sort, page, pageSize]);
  useEffect(() => { let active = true; setNotice("Loading leaderboard…"); void api<LeaderboardReport>(`/reports/leaderboard?${query}`).then((result) => { if (!active) return; setReport(result); if (baseline !== (result.baseline ?? "")) setBaseline(result.baseline ?? ""); if (!baselineStarted(result) && useBaseline) setUseBaseline(false); setNotice(""); }).catch((error: Error) => { if (active) setNotice(error.message); }); return () => { active = false; }; }, [query]);
  useEffect(() => { let active = true; setContests([]); setContestError(""); if (discordEnabled) void api<{ contests: Contest[] }>("/discord/contests").then((review) => { if (active) setContests(review.contests.filter((item) => item.status === "open")); }).catch((error: Error) => { if (active) setContestError(error.message); }); return () => { active = false; }; }, [query, discordEnabled]);
  function updateFilter(action: () => void) { setPage(1); action(); }
  // Last month fills the dates with the whole previous month in the installation's time zone; leaving it clears them.
  const lastMonth = lastMonthRange(report?.today ?? installationToday(report?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
  const periodChoice = useBaseline ? "baseline" : from === lastMonth.from && to === lastMonth.to ? "last_month" : "custom";
  const points = latestTrendPoints(report?.insights.trend ?? [], Number(range));
  // One label chosen: rank by its Attendance rate when it has a policy. The sort control names the basis and still offers Overall rate.
  const labelPolicy = labelId ? labelPolicies.find((policy) => policy.labelId === labelId) : undefined;
  const labelName = report?.labels.find((label) => label.id === labelId)?.name ?? "this label";
  const byLabel = Boolean(labelPolicy && sort === "label-rate");
  function chooseLabel(value: string) { const policy = labelPolicies.find((item) => item.labelId === value); setLabelId(value); if (policy) setSort("label-rate"); else if (sort === "label-rate") setSort("regular-desc"); }
  const rankingTip = leaderboardTip(byLabel && labelPolicy ? { name: labelName, policy: labelPolicy } : undefined);
  async function resolveContest(resolution: "approved" | "rejected" | "reviewed") { if (!reviewing) return; const note = reviewNote.trim(); if (!note) { setReviewError("A review reason is required."); return; } setReviewBusy(true); try { await api("/discord/contests/resolve", { method: "POST", body: JSON.stringify({ meetingId: reviewing.meetingId, memberId: reviewing.memberId, resolution, reviewNote: note }) }); setReviewing(undefined); setReviewNote(""); setContests((current) => current.filter((item) => item !== reviewing)); setNotice(`Contest ${resolution}.`); } catch (error) { setReviewError((error as Error).message); } finally { setReviewBusy(false); } }
  return <>
    {notice && <p className="setup-status" role="status">{notice}</p>}
    {contestError && <p className="setup-status" role="status">Contest review unavailable: {contestError}</p>}
    <section className="task-card report-filters ui-card" data-walkthrough="reports-filters" aria-labelledby="leaderboard-controls-title"><div className="report-filter-heading"><InfoHeading id="leaderboard-controls-title" info="Choose the period, meetings, roster, and label membership used by the fixed attendance leaderboard.">Leaderboard controls</InfoHeading><span className="ui-status" data-tone="neutral">{countText(report?.pagination.totalRows ?? 0, "member")}</span></div><div className="report-filter-controls"><label>Reporting period<select value={periodChoice} onChange={(event) => updateFilter(() => { const value = event.target.value; setUseBaseline(value === "baseline"); if (value === "last_month") { setFrom(lastMonth.from); setTo(lastMonth.to); } else if (periodChoice === "last_month") { setFrom(""); setTo(""); } })}><option value="baseline" disabled={!report || !baselineStarted(report)}>Attendance baseline{report?.baseline ? ` (${report.baseline}${baselineStarted(report) ? "" : ", not started"})` : " unavailable"}</option><option value="last_month">Last month</option><option value="custom">All history / fixed dates</option></select></label><label>From<input type="date" value={useBaseline ? report?.baseline ?? "" : from} disabled={useBaseline} onChange={(event) => updateFilter(() => setFrom(event.target.value))} /></label><label>To<input type="date" value={to} onChange={(event) => updateFilter(() => setTo(event.target.value))} /></label><label>Meeting type<select value={meetingType} onChange={(event) => updateFilter(() => setMeetingType(event.target.value as typeof meetingType))}><option value="all">All meetings</option><option value="required">Required meetings</option><option value="optional">Optional meetings</option></select></label><label>Roster<select value={roster} onChange={(event) => updateFilter(() => setRoster(event.target.value as typeof roster))}><option value="active">Active roster</option><option value="all">Complete history</option></select></label><label>Label group<select value={labelId} onChange={(event) => updateFilter(() => chooseLabel(event.target.value))}><option value="">All labels</option>{report?.labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></label><label>Membership<select value={membership} disabled={!labelId} onChange={(event) => updateFilter(() => setMembership(event.target.value as typeof membership))}><option value="current">Current</option><option value="historical">Historical</option></select></label></div></section>
    {!byLabel && (report?.insights.policyAlerts.length ?? 0) > 0 && <section className="task-card policy-alerts-card ui-card" aria-labelledby="policy-alerts-title"><div className="panel-heading"><h2 id="policy-alerts-title">Below target</h2><span className="status-pill ui-status" data-tone="warning">{report!.insights.policyAlerts.length}</span></div><ul className="report-policy-alerts">{report!.insights.policyAlerts.slice(0, 10).map((item) => <li key={item.key}><RouteLink href={`/roster/${encodeURIComponent(item.memberId)}`} currentPath={path} navigate={navigate}><strong>{item.name}</strong></RouteLink><span className="status-pill ui-status report-policy-warning" data-tone="warning">{policyResultText(item.policy)}</span></li>)}</ul></section>}
    <section className="report-grid"><article className="task-card leaderboard-card ui-card" data-walkthrough="reports-results"><div className="panel-heading leaderboard-heading"><InfoHeading info={<CalcTipContent tip={rankingTip} footer={rankingTip.switchHint} />}>Attendance leaderboard</InfoHeading><label className="leaderboard-sort"><svg className="leaderboard-sort-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M7 4v16m0-16L3 8m4-4 4 4m6 12V4m0 16-4-4m4 4 4-4" /></svg><select aria-label="Sort attendance leaderboard" value={sort} onChange={(event) => updateFilter(() => setSort(event.target.value as typeof sort))}>{labelPolicy && <option value="label-rate">Attendance rate: {labelName}</option>}<option value="regular-desc">Overall rate</option><option value="first-name">First name</option><option value="last-name">Last name</option></select></label></div>{byLabel && <p className="report-field-help leaderboard-basis">Ranked by {labelName} attendance rate because one label is chosen.</p>}<div className="report-table-scroll"><div className="report-table compact-leaderboard" role="table" aria-label="Attendance leaderboard"><div className="report-row header" role="row"><span role="columnheader">Member</span>{byLabel && labelPolicy ? <span role="columnheader" className="term-with-info">Attendance rate<CalcTip label="About Attendance rate" tip={labelRateTip(labelName, labelPolicy)} /></span> : <span role="columnheader" className="term-with-info">Overall rate<CalcTip label="About Overall rate" tip={overallRateTip()} /></span>}</div>{report?.members.map((item) => <div className="report-row" role="row" key={item.member.id}><span role="cell"><RouteLink href={`/roster/${encodeURIComponent(item.member.memberId)}`} currentPath={path} navigate={navigate}>{item.member.firstName} {item.member.lastName}</RouteLink></span>{byLabel ? <span role="cell" className="leaderboard-rate-cell"><span className="ui-status" data-tone={statusTone(item.labelResult?.status ?? "no_rule")}>{attendanceStatusText(item.labelResult?.status ?? "no_rule")}</span>{item.labelResult?.rate == null ? <NoValue /> : rateText(item.labelResult.rate)}</span> : <span role="cell">{(item.regularAttendance.preciseRate ?? item.regularAttendance.rate) === null ? <NoValue /> : rateText(item.regularAttendance.preciseRate ?? item.regularAttendance.rate)}</span>}</div>)}{!report?.members.length && <p className="empty-state">No attendance records match these filters.</p>}</div></div><Pagination pagination={report?.pagination} page={page} pageSize={pageSize} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} /></article>
      <article className="task-card trend-card ui-card" data-walkthrough="reports-trend"><div className="panel-heading"><InfoHeading info="Weighted overall rate at each completed required meeting.">Team overall rate trend</InfoHeading><label>Meetings<select value={range} onChange={(event) => setRange(event.target.value)}><option value="5">Last 5</option><option value="10">Last 10</option><option value="20">Last 20</option></select></label></div>{points.length ? <AttendanceTrendChart points={points} timeZone={report?.timeZone} /> : <p className="empty-state">No completed meetings match these filters.</p>}</article>
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
  const next: ReportDefinition = { ...cloneReportDefinition(current), version: 2, dataset: dataset.id, groupBy: [...dataset.groupBy], period: dataset.filters.includes("period") ? current.period.type === "baseline" ? { type: "baseline" } : { ...current.period } : { type: "all" }, roster: "active", meetingType: "all", labelIds: [], labelMatch: "any", ...emptyModuleFilterSelections(catalog.reportFilters), membership: "current", columns: dataset.defaultColumns.filter((key) => dataset.fields.find((field) => field.id === key)?.available !== false).map(column), columnFilters: [], sort: { column: column(dataset.defaultSort.field), direction: dataset.defaultSort.direction } };
  // Another report type uses its own module's baseline; one that has not started would leave the report empty.
  if (next.period.type === "baseline" && !reportBaselineStarted(definitionBaseline(catalog, next)?.startsOn, catalog.today)) next.period = { type: "all" };
  return next;
}

function ReportStart({ catalog, onCreate }: { catalog: ReportCatalog; onCreate: (definition: ReportDefinition) => void }) {
  return <section className="task-card ui-card report-builder" aria-labelledby="report-start-title"><div className="panel-heading"><div><h2 id="report-start-title">Build a report</h2><p>Choose the row type that answers your question. Saved views keep their dataset, columns, filters, and sort order.</p></div></div><div className="report-dataset-cards">{reportTypes(catalog).filter((dataset) => dataset.available).map((dataset) => <article key={dataset.id}><div><h3>{dataset.label}</h3><p>{dataset.description}</p></div><button className="ui-button ui-button--primary" type="button" onClick={() => onCreate(reportDefinitionForDataset(catalog, dataset.id))}>Create report</button></article>)}</div></section>;
}

function definitionForDashboard(definition: ReportDefinition, catalog: ReportCatalog) {
  const next = cloneReportDefinition(definition); const dataset = catalog.datasets.find((item) => item.id === next.dataset);
  for (const filter of catalog.reportFilters) { next[filter.selectionKey] ??= []; next[filter.matchKey] ??= "any"; }
  const normalizeColumn = (column: ReportDefinition["columns"][number]) => {
    const unit = column.unit ?? dataset?.fields.find((field) => field.id === column.key)?.defaultDurationUnit;
    return unit ? { ...column, unit } : column;
  };
  next.columns = next.columns.map(normalizeColumn);
  next.sort.column = normalizeColumn(next.sort.column);
  next.columnFilters = (next.columnFilters ?? []).map((filter) => ({ ...filter, column: normalizeColumn(filter.column) }));
  return next;
}

function periodText(period: ReportDefinition["period"], catalog: ReportCatalog, definition: ReportDefinition) {
  if (period.type === "fixed") return `${period.from} to ${period.to}`;
  if (period.type === "last_month") { const range = lastMonthRange(installationToday(catalog.timeZone)); return `Last month (${range.from} to ${range.to})`; }
  if (period.type === "all") return "All history";
  if (period.type === "baseline") return baselinePeriodText(definitionBaseline(catalog, definition));
  if (period.type === "last_days") return `Last ${countText(period.days, "day")}`;
  if (period.type === "current_month") return "Current month";
  return "Current year";
}


/**
 * Presets above a new report. "Attendance by label" asks which labels to include (those with a policy are preselected,
 * those without are listed but disabled), says what it will add, then takes a period and name and saves the report.
 */
function ReportPresets({ catalog, onCreated }: { catalog: ReportCatalog; onCreated: (report: SavedReport) => Promise<void> }) {
  const policies = new Map((catalog.labelPolicies ?? []).map((policy) => [policy.labelId, policy]));
  const labels = catalog.labels.filter((label) => label.active);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>(() => labels.filter((label) => policies.has(label.id)).slice(0, attendanceByLabelPreset.maxLabels).map((label) => label.id));
  const [periodChoice, setPeriodChoice] = useState("last_90");
  const [name, setName] = useState<string>(attendanceByLabelPreset.defaultReportName);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const baselineReady = reportBaselineStarted(definitionBaseline(catalog, { dataset: "attendance.members", columns: [], period: { type: "baseline" } } as unknown as ReportDefinition)?.startsOn, catalog.today);
  const selected = labels.filter((label) => chosen.includes(label.id) && policies.has(label.id)).map((label) => ({ name: label.name, policy: policies.get(label.id)! }));
  const summary = attendanceByLabelSummary(selected);
  const full = selected.length >= attendanceByLabelPreset.maxLabels;
  async function create() {
    if (busy || !selected.length || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const definition = attendanceByLabelDefinition(selected.map((label) => label.policy), reportPeriodFromChoice(periodChoice, installationToday(catalog.timeZone)));
      const { report } = await api<{ report: SavedReport }>("/reports/views", { method: "POST", body: JSON.stringify({ name: name.trim(), scope: "personal", definition }) });
      await onCreated(report);
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  return <section className="task-card ui-card report-builder report-presets" aria-labelledby="report-presets-title">
    <h3 className="report-start-group" id="report-presets-title">Start from a preset</h3>
    <div className="report-dataset-cards">
      <article className={`report-preset-card${open ? " is-open" : ""}`}>
        <div><h3>{attendanceByLabelPreset.name}</h3><p>{attendanceByLabelPreset.description}</p>
          {open && <>
            <fieldset className="report-preset-labels" disabled={busy}><legend>Labels to include</legend><div className="report-column-options">{labels.map((label) => { const policy = policies.get(label.id); const checked = Boolean(policy) && chosen.includes(label.id); const disabled = !policy || !checked && full; return <label className={`report-column-option${disabled ? " is-unavailable" : ""}`} key={label.id}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => setChosen((current) => event.target.checked ? [...current, label.id] : current.filter((id) => id !== label.id))} /><span>{label.name}<small>{policy ? labelPolicyText(policy, { showWeighted: true }) : "No policy: no columns to add"}</small></span></label>; })}{!labels.length && <p className="empty-state">No labels yet. Create labels and attendance policies in Settings.</p>}</div>{full && <p className="report-field-help">Up to {attendanceByLabelPreset.maxLabels} labels fit in one report.</p>}</fieldset>
            <div className="report-preset-adds" role="status"><strong>{summary.heading}</strong><span>{summary.columns}</span><span>{summary.filter}</span></div>
            <div className="report-preset-row"><label>Period<select value={periodChoice} disabled={busy} onChange={(event) => setPeriodChoice(event.target.value)}>{presetPeriodOptions.map(([value, label]) => <option key={value} value={value} disabled={value === "baseline" && !baselineReady}>{label}{value === "baseline" && !baselineReady ? " (not set)" : ""}</option>)}</select></label><label>Report name<input value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} /></label></div>
            {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
            <div className="report-preset-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>Cancel</button><button className="ui-button ui-button--primary" type="button" disabled={busy || !selected.length || !name.trim()} onClick={() => void create()}>{busy ? "Creating…" : "Create report"}</button></div>
          </>}
        </div>
        {!open && <button className="ui-button ui-button--primary" type="button" aria-label={`Use the ${attendanceByLabelPreset.name} preset`} onClick={() => setOpen(true)}>Use preset</button>}
      </article>
    </div>
  </section>;
}

function ReportEditor({ catalog, saved, draft, pinnedIds, onDirtyChange, onLibrariesChanged, onNavigate, onTogglePin, editorRef, onSavedNavigate, onDeleted }: { editorRef: React.Ref<ReportEditorHandle>; catalog: ReportCatalog; saved?: SavedReport; draft?: Draft; pinnedIds: string[]; onDirtyChange: (dirty: boolean) => void; onLibrariesChanged: () => Promise<void>; onNavigate: (path: string) => void; onSavedNavigate: (path: string) => void; onDeleted?: (id: string) => void; onTogglePin: (id: string) => Promise<void> }) {
  const sourceDefinition = saved?.definition ?? draft?.definition ?? reportDefinitionForDataset(catalog, membersDataset(catalog)?.id ?? catalog.defaultDefinition.dataset);
  const seed = { name: saved?.name ?? draft?.name ?? "Untitled report", scope: saved?.scope ?? draft?.scope ?? "personal", definition: definitionForDashboard(sourceDefinition, catalog), imported: Boolean(draft?.imported) };
  const [name, setName] = useState(seed.name), [scope, setScope] = useState<ReportScope>(seed.scope);
  const [definition, setDefinition] = useState(seed.definition), [editing, setEditing] = useState(!saved);
  const [notice, setNotice] = useState(""), [reload, setReload] = useState(0);
  const [operation, setOperation] = useState<"saving" | "exporting" | "deleting" | "pinning">();
  const pending = useRef(false), alive = useRef(true), deleted = useRef(false);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState<25 | 50 | 100 | "all">(25);
  // `trail` holds the views a picked filter came from, so Back returns through the drill-in one step at a time.
  const [filterPopover, setFilterPopover] = useState<{ view: FilterView; anchor: HTMLElement; fromPicker: boolean; trail?: FilterView[] }>(); const addFilterButton = useRef<HTMLButtonElement | null>(null);
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
  useEffect(() => { if (deleted.current) return; onDirtyChange(!saved || dirty); if (!saved) saveDraft({ name, scope, definition, imported: seed.imported }); }, [editing, dirty, name, scope, definition, saved]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (deleted.current || (saved && !dirty)) return; event.preventDefault(); event.returnValue = ""; };
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
  const labelNames = new Map(catalog.labels.map((label) => [label.id, label.name]));
  const setFilterIds = (next: ReportDefinition, filter: ReportModuleFilter, ids: string[]) => { next[filter.selectionKey] = ids; };
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
      if (seed.imported) removeStorage("local", legacyViewKey);
      const nextDefinition = definitionForDashboard(report.definition, catalog);
      setName(report.name); setScope(report.scope); setDefinition(nextDefinition);
      original.current = { name: report.name, scope: report.scope, definition: cloneReportDefinition(nextDefinition), revision: report.revision, imported: false };
      setEditing(false); onDirtyChange(false); setNotice("");
      try { await onLibrariesChanged(); } catch { setNotice("Report saved. Reload the page to refresh the report library."); }
      if (alive.current) { removeStorage("session", draftKey); if (navigateAfter) onSavedNavigate("/reports/view/" + encodeURIComponent(report.id)); }
      return { ok: true };
    } catch (error) { const message = (error as Error).message + (!saved || copy ? " Check Browse reports before trying to save again." : ""); if (alive.current) setNotice(message); return { ok: false, error: message }; }
    finally { finishOperation(); }
  }
  async function remove() {
    if (!saved || pending.current || !window.confirm("Delete " + saved.name + "? " + (saved.scope === "shared" ? "This removes it for everyone who can access it." : "This removes your private report.") + (dirty ? " Your unsaved changes will be discarded." : ""))) return;
    if (!startOperation("deleting")) return;
    try {
      await api("/reports/views/" + encodeURIComponent(saved.id) + "?revision=" + original.current.revision, { method: "DELETE" });
      deleted.current = true; onDirtyChange(false); onDeleted?.(saved.id);
    }
    catch (error) { if (alive.current) setNotice((error as Error).message); }
    finally { finishOperation(); }
  }
  async function download(detail: boolean) {
    if (loading || queryError || exportPaused || !startOperation("exporting")) return;
    try {
      const response = await fetch(apiBaseUrl + (detail ? "/exports/report-detail.csv" : "/exports/report.csv"), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? "CSV export failed"); }
      saveBlob(await response.blob(), reportExportFilename(name, detail));
      if (alive.current) setNotice("CSV downloaded for all matching rows using the current filters.");
    } catch (error) { if (alive.current) setNotice((error as Error).message); }
    finally { finishOperation(); }
  }
  async function togglePin() { if (!saved || !startOperation("pinning")) return; try { await onTogglePin(saved.id); } finally { finishOperation(); } }
  // Filters live in the results table: a funnel per column, + Filter for any field, and chips for the active ones.
  // Filters stay part of the saved definition, so changing one marks a saved report as having unsaved changes.
  const filterable = Boolean(saved);
  const targetKey = (target: ReportFilterTarget) => reportFilterTargetKey(target, reportColumnId);
  const viewKey = (view: FilterView) => typeof view === "string" ? view : view.kind === "label-fields" ? "label-fields" : view.kind === "label-field" ? `label-field:${view.key}` : targetKey(view);
  const openKey: string | undefined = !filterPopover ? undefined : viewKey(filterPopover.view);
  const fieldOf = (key: string) => dataset.fields.find((field) => field.id === key);
  const shownIds = new Set(definition.columns.map(reportColumnId));
  const columnFilterFor = (column: ReportColumn) => definition.columnFilters?.find((filter) => reportColumnId(filter.column) === reportColumnId(column));
  const moduleFilters = catalog.reportFilters.filter((filter) => supports.has(filter.id)).map((filter) => ({ filter, selection: moduleFilterSelection(definition, filter), names: new Map(filter.options.map((option) => [option.id, option.name])) }));
  useEffect(() => { if (busy) setFilterPopover(undefined); }, [busy]);
  function openFilter(view: FilterView, anchor: HTMLElement) {
    if (busy) return;
    const key = viewKey(view);
    if (filterPopover?.anchor === anchor && openKey === key) { closeFilter(false); return; }
    setFilterPopover({ view, anchor, fromPicker: false });
  }
  function closeFilter(returnFocus: boolean) {
    const anchor = filterPopover?.anchor; setFilterPopover(undefined);
    if (returnFocus) window.requestAnimationFrame(() => (anchor?.isConnected ? anchor : addFilterButton.current)?.focus());
  }
  function applyFilter(mutator: (next: ReportDefinition) => void) { change(mutator); closeFilter(true); }
  function setColumnFilter(column: ReportColumn, operator: ReportColumnFilter["operator"], value: string, upperValue?: string) {
    const id = reportColumnId(column); const filters = definition.columnFilters ?? [];
    if (!filters.some((filter) => reportColumnId(filter.column) === id) && filters.length >= 16) { setNotice("A report can have at most 16 column filters."); return; }
    const filter: ReportColumnFilter = { column, operator, value, ...(upperValue !== undefined ? { upperValue } : {}) };
    applyFilter((next) => { const current = next.columnFilters ?? []; next.columnFilters = current.some((item) => reportColumnId(item.column) === id) ? current.map((item) => reportColumnId(item.column) === id ? filter : item) : [...current, filter]; });
  }
  const removeColumnFilter = (column: ReportColumn) => (next: ReportDefinition) => { next.columnFilters = (next.columnFilters ?? []).filter((item) => reportColumnId(item.column) !== reportColumnId(column)); };
  const chips: { key: string; text: string; shown: boolean; target: ReportFilterTarget; clear: (next: ReportDefinition) => void }[] = [];
  for (const filter of definition.columnFilters ?? []) chips.push({ key: targetKey({ kind: "column", column: filter.column }), text: reportColumnFilterText(columnName(filter.column), filter), shown: shownIds.has(reportColumnId(filter.column)), target: { kind: "column", column: filter.column }, clear: removeColumnFilter(filter.column) });
  if (supports.has("labels") && definition.labelIds.length) chips.push({ key: "labels", text: `Labels${definition.labelMatch === "all" && definition.labelIds.length > 1 ? " (all)" : ""}: ` + definition.labelIds.map((id) => labelNames.get(id) ?? "Unavailable label").join(", "), shown: false, target: { kind: "labels" }, clear: (next) => { next.labelIds = []; } });
  for (const { filter, selection, names } of moduleFilters) if (selection.ids.length) chips.push({ key: "module:" + filter.id, text: `${filter.label}${selection.match === "all" && selection.ids.length > 1 ? " (all)" : ""}: ` + selection.ids.map((id) => names.get(id) ?? "Unavailable " + filter.optionLabel).join(", "), shown: false, target: { kind: "module", filterId: filter.id }, clear: (next) => { setFilterIds(next, filter, []); } });
  if (supports.has("roster") && definition.roster === "active") chips.push({ key: "roster", text: "Roster: Active members", shown: true, target: { kind: "roster" }, clear: (next) => { next.roster = "all"; } });
  if (supports.has("meeting-type") && definition.meetingType !== "all") chips.push({ key: "meetings", text: definition.meetingType === "required" ? "Meetings: Required" : "Meetings: Optional", shown: true, target: { kind: "meetings" }, clear: (next) => { next.meetingType = "all"; } });
  function removeChip(chip: typeof chips[number]) {
    if (openKey === chip.key) setFilterPopover(undefined);
    change(chip.clear); window.requestAnimationFrame(() => addFilterButton.current?.focus());
  }
  function clearFilters() {
    setFilterPopover(undefined);
    change((next) => { next.roster = "all"; next.meetingType = "all"; next.labelIds = []; for (const filter of catalog.reportFilters) setFilterIds(next, filter, []); next.columnFilters = []; });
    window.requestAnimationFrame(() => addFilterButton.current?.focus());
  }
  const typeHint = (field: ReportDataset["fields"][number]) => field.durationUnits ? "Duration" : field.valueType === "number" ? "Number" : field.valueType === "date" ? "Date" : "Text";
  const pick = (view: ReportFilterTarget | LabelFieldView) => () => setFilterPopover((current) => current && { ...current, view, fromPicker: true, trail: [...(current.trail ?? []), current.view] });
  const filterableField = (field?: ReportDataset["fields"][number]) => Boolean(field && field.available !== false && field.filterOperators.length);
  const pickerGroups: { title: string; items: ReportFilterPickerItem[] }[] = [
    { title: "In this report", items: definition.columns.filter((column) => filterableField(fieldOf(column.key))).map((column) => ({ key: targetKey({ kind: "column", column }), name: columnName(column), hint: typeHint(fieldOf(column.key)!), filtered: Boolean(columnFilterFor(column)), onPick: pick({ kind: "column", column }) })) },
    { title: "Not in the table", items: [
      ...(supports.has("labels") ? [{ key: "labels", name: "Labels", hint: "Choose from a list", filtered: definition.labelIds.length > 0, onPick: pick({ kind: "labels" }) }] : []),
      ...moduleFilters.map(({ filter, selection }) => ({ key: "module:" + filter.id, name: filter.label, hint: "Choose from a list", filtered: selection.ids.length > 0, onPick: pick({ kind: "module", filterId: filter.id }) })),
      ...(supports.has("roster") ? [{ key: "roster", name: "Roster", hint: "Active or all members", filtered: definition.roster === "active", onPick: pick({ kind: "roster" }) }] : []),
      ...(supports.has("meeting-type") ? [{ key: "meetings", name: "Meetings", hint: "All, required or optional", filtered: definition.meetingType !== "all", onPick: pick({ kind: "meetings" }) }] : []),
      // Fields that need a label, such as a label set's Status, through a field-then-label drill-in.
      ...(dataset.fields.some((field) => filterableField(field) && field.requiresLabel) && catalog.labels.length ? [{ key: "label-fields", name: "Attendance policies (per label)", hint: "Choose a field, then a label", filtered: (definition.columnFilters ?? []).some((filter) => filter.column.labelId && !shownIds.has(reportColumnId(filter.column))), onPick: pick({ kind: "label-fields" }) }] : []),
      ...dataset.fields.filter((field) => filterableField(field) && !field.requiresLabel && !shownIds.has(field.id)).map((field) => {
        const column: ReportColumn = columnFilterFor({ key: field.id })?.column ?? (field.defaultDurationUnit ? { key: field.id, unit: field.defaultDurationUnit } : { key: field.id });
        return { key: targetKey({ kind: "column", column }), name: columnName(column), hint: typeHint(field), filtered: Boolean(columnFilterFor(column)), onPick: pick({ kind: "column", column }) };
      }),
    ] },
  ].filter((group) => group.items.length);
  function filterContent(view: FilterView) {
    const onBack = filterPopover?.fromPicker ? () => setFilterPopover((current) => { if (!current) return current; const trail = [...(current.trail ?? [])]; const previous = trail.pop() ?? "picker"; return { ...current, view: previous, trail, fromPicker: previous !== "picker" || trail.length > 0 }; }) : undefined;
    if (view === "picker") return <ReportFilterPicker groups={pickerGroups} activeCount={chips.length} />;
    if (typeof view !== "string" && view.kind === "label-fields") return <ReportFilterChoiceList key="label-fields" title="Attendance policies (per label)" searchLabel="Search fields" onBack={onBack} items={dataset.fields.filter((field) => filterableField(field) && field.requiresLabel).map((field) => ({ key: field.id, name: field.label, hint: "Choose a label", filtered: (definition.columnFilters ?? []).some((filter) => filter.column.key === field.id), onPick: pick({ kind: "label-field", key: field.id }) }))} />;
    if (typeof view !== "string" && view.kind === "label-field") { const field = fieldOf(view.key); return <ReportFilterChoiceList key={"label-field:" + view.key} title={field?.label ?? "Field"} searchLabel="Search labels" onBack={onBack} items={catalog.labels.map((label) => { const column = columnFilterFor({ key: view.key, labelId: label.id })?.column ?? { key: view.key, labelId: label.id }; return { key: label.id, name: label.name, hint: shownIds.has(reportColumnId(column)) ? "In this report" : label.active ? "Not in the table" : "Retired", filtered: Boolean(columnFilterFor(column)), onPick: pick({ kind: "column", column }) }; })} />; }
    if (view === "period") return <ReportPeriodEditor catalog={catalog} definition={definition} resolved={visibleResult?.resolvedPeriod} membership={supports.has("membership")} onApply={(period, membership) => applyFilter((next) => { next.period = period; next.membership = membership; })} />;
    if (view.kind === "column") {
      const column = definition.columns.find((item) => reportColumnId(item) === reportColumnId(view.column)) ?? columnFilterFor(view.column)?.column ?? view.column;
      const field = fieldOf(column.key);
      if (!field?.filterOperators.length) return <p className="empty-state">This field can't be filtered.</p>;
      const durationUnit = field.durationUnits ? column.unit ?? field.defaultDurationUnit ?? "minutes" : undefined;
      return <ReportColumnFilterControl key={targetKey(view)} title={columnName(column)} status={shownIds.has(reportColumnId(column)) ? "Filter" : "Not shown"} field={field} filter={columnFilterFor(column)} unit={durationUnit} onBack={onBack} onApply={(operator, value, upperValue) => setColumnFilter({ ...column, ...(durationUnit ? { unit: durationUnit } : {}) }, operator, value, upperValue)} onClear={() => applyFilter(removeColumnFilter(column))} />;
    }
    if (view.kind === "labels") return <ReportChoiceFilter key="labels" title="Labels" status="Not shown" noun="label" options={catalog.labels.map((label) => ({ id: label.id, name: label.name, note: label.active ? undefined : "Retired" }))} missingIds={definition.labelIds.filter((id) => !labelNames.has(id))} missingName="Unavailable label" selected={definition.labelIds} match={definition.labelMatch} onBack={onBack} onApply={(ids, match) => applyFilter((next) => { next.labelIds = ids; if (ids.length) next.labelMatch = match; })} />;
    if (view.kind === "module") {
      const entry = moduleFilters.find((item) => item.filter.id === view.filterId);
      if (!entry) return <p className="empty-state">This filter is unavailable.</p>;
      const { filter, selection, names } = entry;
      return <ReportChoiceFilter key={filter.id} title={filter.label} status="Not shown" noun={filter.optionNoun} options={filter.options.map((option) => ({ id: option.id, name: option.name, note: option.archived ? "Archived" : undefined }))} missingIds={selection.ids.filter((id) => !names.has(id))} missingName={"Unavailable " + filter.optionLabel} selected={selection.ids} match={selection.match} onBack={onBack} onApply={(ids, match) => applyFilter((next) => { setFilterIds(next, filter, ids); if (ids.length) next[filter.matchKey] = match; })} />;
    }
    if (view.kind === "roster") return <ReportOptionFilter key="roster" title="Roster" options={[{ value: "active", label: "Active members" }, { value: "all", label: "All members" }]} value={definition.roster} clearValue="all" help="Active members leaves out members marked inactive." onBack={onBack} onApply={(value) => applyFilter((next) => { next.roster = value; })} />;
    return <ReportOptionFilter key="meetings" title="Meetings" options={[{ value: "all", label: "All meetings" }, { value: "required", label: "Required meetings" }, { value: "optional", label: "Optional meetings" }]} value={definition.meetingType} clearValue="all" help="Which meetings attendance measures count." onBack={onBack} onApply={(value) => applyFilter((next) => { next.meetingType = value; })} />;
  }
  const filterLabel = (view: FilterView) => view === "picker" ? "Add a filter" : view === "period" ? "Report period" : view.kind === "label-fields" ? "Filter a per-label field" : view.kind === "label-field" ? `Filter ${fieldOf(view.key)?.label ?? "field"}: choose a label` : view.kind === "column" ? "Filter " + columnName(view.column) : view.kind === "labels" ? "Filter Labels" : view.kind === "module" ? "Filter " + (catalog.reportFilters.find((filter) => filter.id === view.filterId)?.label ?? "list") : view.kind === "roster" ? "Filter Roster" : "Filter Meetings";
  const periodLabel = periodText(definition.period, catalog, definition);
  const rowsText = loading ? "Refreshing…" : visibleResult?.state === "paused" ? "Paused" : visibleResult ? countText(visibleResult.pagination.totalRows, "matching row") : "Results unavailable";
  const resolvedRange = supports.has("period") && definition.period.type !== "all" && visibleResult?.resolvedPeriod.from ? `${visibleResult.resolvedPeriod.from} – ${visibleResult.resolvedPeriod.to}` : "";
  const reportActions = saved && <ReportMenu label="Report actions"><button className="ui-button" type="button" disabled={busy} onClick={() => void save(true)}>Save as copy</button><button className="ui-button" type="button" disabled={busy} onClick={() => void togglePin()}>{pinnedIds.includes(saved.id) ? "Unpin report" : "Pin report"}</button><button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => void remove()}>Delete report</button></ReportMenu>;
  return <section className="saved-report-workspace" aria-labelledby="saved-report-title" aria-busy={busy}>
    {!saved && catalog.attendanceAvailable && <ReportPresets catalog={catalog} onCreated={async (report) => { try { await onLibrariesChanged(); } catch { /* The new report still opens; the library refreshes on reload. */ } if (alive.current) { removeStorage("session", draftKey); onSavedNavigate("/reports/view/" + encodeURIComponent(report.id)); } }} />}
    <section className="task-card ui-card report-builder report-results report-merged" data-walkthrough="report-builder" aria-busy={loading}>
      <div className="report-builder-heading">
        <div><h2 id="saved-report-title">{saved ? saved.name : "New report"}</h2><div className="report-scope-line"><p className="report-compact-scope">{dataset.label}{supports.has("period") ? " ·" : ""}</p>{supports.has("period") && (filterable ? <button className="ui-button report-period-chip" type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={openKey === "period"} aria-label={"Report period: " + periodLabel} onClick={(event) => openFilter("period", event.currentTarget)}><svg className="report-action-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M7 3v4m10-4v4M4 9h16M5 5h14v15H5z" /></svg><span>{periodLabel}</span><ReportChevron /></button> : <p className="report-compact-scope">{periodLabel}</p>)}</div></div>
        <div className="report-builder-heading-actions" data-walkthrough={editing ? undefined : "report-actions"}><span className="ui-status" data-tone="neutral">{reportScopeLabel(scope)}</span>{saved && !editing && <button className="ui-button report-icon-button" type="button" disabled={busy} onClick={() => { setFilterPopover(undefined); setEditing(true); }}><svg className="report-action-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m16 3 5 5-12 12-6 1 1-6L16 3Zm-3 3 5 5" /></svg><span>Edit</span></button>}{!editing && reportActions}</div>
      </div>
      {!dataset.available && <p className="ui-status" data-tone="warning">This dataset is unavailable for your current module access. Its definition remains editable, while results and exports stay paused.</p>}
      {saved?.warnings.map((warning) => <p className="ui-status" data-tone="warning" key={warning}>{warning}</p>)}
      {editing && <details className="report-settings-details report-edit-settings" open><summary><span>Report settings</span><ReportChevron /></summary><fieldset className="report-edit-fields" disabled={busy}><legend className="visually-hidden">Report settings</legend><div className="report-builder-identity"><label>Report name<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label><label>Report type<select aria-label="Report type" aria-describedby="report-dataset-help" value={dataset.id} onChange={(event) => { setPage(1); setFilterPopover(undefined); setDefinition((current) => reportDefinitionForDataset(catalog, event.target.value, current)); }}>{reportTypes(catalog).map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? "" : " - unavailable"}</option>)}</select></label><label>Visibility<select value={scope} onChange={(event) => setScope(event.target.value as ReportScope)}><option value="personal">Private</option><option value="shared">Shared</option></select></label></div><p id="report-dataset-help" className="report-field-help">{dataset.description}</p><p className="report-field-help">{scope === "shared" ? "Administrators and operators can view and edit this shared report. Results still follow each account’s module access." : "Only you can access this private report."}</p></fieldset></details>}
      <div className="report-control-actions" data-walkthrough={editing ? "report-actions" : undefined}>
        {editing && <button className="ui-button ui-button--primary" type="button" disabled={busy || !name.trim() || Boolean(saved && !dirty)} onClick={() => void save()}>{operation === "saving" ? "Saving…" : "Save"}</button>}
        {saved && editing && <button className="ui-button" type="button" disabled={busy} onClick={cancelEdit}>Cancel</button>}
        {saved && !editing && dirty && <><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void save()}>{operation === "saving" ? "Saving…" : "Save view"}</button><button className="ui-button" type="button" disabled={busy} onClick={() => { setFilterPopover(undefined); resetView(); }}>Reset view</button></>}
        {(!saved || dirty) && <span className="ui-status report-state-pill" data-tone="warning" role="status">{!saved ? "DRAFT" : "UNSAVED CHANGES"}</span>}
        {operation && <span className="report-view-state" role="status">{operation === "saving" ? "Saving…" : operation === "exporting" ? "Exporting…" : operation === "deleting" ? "Deleting report…" : "Updating pin…"}</span>}
        {saved && scope === "shared" && dirty && <span className="report-field-help">Saving updates the shared report for everyone.</span>}
        {editing && reportActions}
      </div>
      {notice && <p className="setup-status" role="status">{notice}</p>}
      <p className="report-results-meta"><span role="status">{rowsText}</span>{resolvedRange && <> · <span className="report-resolved-period">{resolvedRange}</span></>}</p>
      {invalidPeriod && <p className="ui-status" data-tone="error">Choose an end date on or after the start date.</p>}
      {filterable && chips.length > 0 && <div className="report-filter-chips" role="group" aria-label="Applied report filters">{chips.map((chip) => <span className="report-filter-chip-group" key={chip.key}><button className={`ui-button report-filter-chip${openKey === chip.key ? " is-active" : ""}`} type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={openKey === chip.key} aria-label={"Edit filter: " + chip.text} onClick={(event) => openFilter(chip.target, event.currentTarget)}><ColumnIcon name={chip.shown ? "filter" : "hidden"} /><span>{chip.text}</span>{!chip.shown && <small>Not shown</small>}</button><button className="ui-button report-filter-chip-remove" type="button" disabled={busy} aria-label={"Remove filter: " + chip.text} onClick={() => removeChip(chip)}>×</button></span>)}<button className="ui-button" type="button" disabled={busy} onClick={clearFilters}>Clear filters</button></div>}
      {queryError && <p className="ui-status" data-tone="error" role="alert">{queryError} Previous results are hidden. <button className="ui-button" type="button" onClick={() => { setResponse(undefined); setReload((value) => value + 1); }}>Retry report</button></p>}
      {visibleResult?.pausedReasons?.map((reason) => <p className="ui-status report-paused-notice" data-tone="warning" role="status" key={reason}>{reason} The definition and its controls have been preserved.</p>)}
      {visibleResult?.warnings.map((warning) => <p className="ui-status" data-tone="warning" key={warning}>{warning}</p>)}
      <div className="report-results-body" data-walkthrough="reports-results">
        <EditableReportTable catalog={catalog} definition={definition} result={visibleResult} loading={loading || Boolean(queryError)} editable={!busy} filterable={filterable} openFilterId={openKey?.startsWith("column:") ? openKey.slice("column:".length) : undefined} onFilterColumn={filterable ? (column, trigger) => openFilter({ kind: "column", column }, trigger) : undefined} onMenuOpen={() => setFilterPopover(undefined)} onChange={change} onNavigate={onNavigate} onNotice={setNotice} toolbar={<>
          {filterable && searchAvailable && <label className="report-results-search">Search {columnName(searchColumn).toLowerCase()}<input className="ui-control" type="search" aria-label="Search report results" value={searchValue} disabled={busy} placeholder={"Search " + columnName(searchColumn).toLowerCase()} onChange={(event) => change((next) => { const remaining = (next.columnFilters ?? []).filter((filter) => reportColumnId(filter.column) !== reportColumnId(searchColumn)); next.columnFilters = event.target.value ? [...remaining, { column: searchColumn, operator: "contains", value: event.target.value }] : remaining; })} /></label>}
          {filterable && <button ref={addFilterButton} className="ui-button report-add-filter-button" type="button" disabled={busy} aria-label="Add filter" aria-haspopup="dialog" aria-expanded={openKey === "picker" || Boolean(filterPopover?.fromPicker)} onClick={(event) => openFilter("picker", event.currentTarget)}><ColumnIcon name="add" /><span>Filter</span></button>}
          <ReportMenu label={operation === "exporting" ? "Exporting…" : "Export"} icon={<svg className="report-menu-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" /></svg>}><p>Exports include all matching rows using the current filters{dirty ? ", including unsaved changes" : ""}.</p><button className="ui-button" type="button" disabled={busy || loading || Boolean(queryError) || exportPaused} aria-label="Download report CSV" onClick={() => void download(false)}>Download report CSV<small>Selected columns and current sort order</small></button>{isMemberReport(catalog, definition.dataset) && catalog.attendanceAvailable && <button className="ui-button" type="button" disabled={busy || loading || Boolean(queryError) || exportPaused} aria-label="Download detailed attendance CSV" onClick={() => void download(true)}>Download detailed attendance CSV<small>Meeting-level attendance records for this report</small></button>}{exportPaused && <p>Export is paused while a controlling report source is unavailable.</p>}</ReportMenu>
        </>} />
        <Pagination pagination={visibleResult?.pagination} page={page} pageSize={pageSize} pending={loading} unavailable={!visibleResult || visibleResult.state === "paused"} onPage={setPage} onPageSize={(value) => { setPageSize(value); setPage(1); }} />
      </div>
    </section>
    {filterPopover && <ReportPopover anchor={filterPopover.anchor} label={filterLabel(filterPopover.view)} tall={filterPopover.view === "picker" || filterPopover.fromPicker} view={viewKey(filterPopover.view)} onClose={closeFilter}>{filterContent(filterPopover.view)}</ReportPopover>}
  </section>;
}

/** The period chip's popover: the report period, a combined report's baseline, and label membership. Applies together. */
function ReportPeriodEditor({ catalog, definition, resolved, membership: offersMembership, onApply }: { catalog: ReportCatalog; definition: ReportDefinition; resolved?: ReportQueryResult["resolvedPeriod"]; membership: boolean; onApply: (period: ReportDefinition["period"], membership: ReportDefinition["membership"]) => void }) {
  const [period, setPeriod] = useState(definition.period); const [membership, setMembership] = useState(definition.membership);
  const draft = { ...definition, period };
  const baselineInfo = definitionBaseline(catalog, draft);
  const baselineChoices = period.type === "baseline" && definition.dataset === "core.combined-members" ? combinedBaselineChoices(catalog, draft) : [];
  const invalid = period.type === "fixed" && (!period.from || !period.to || period.from > period.to);
  const unchanged = JSON.stringify(period) === JSON.stringify(definition.period);
  return <form className="report-filter-form" onSubmit={(event) => { event.preventDefault(); if (!invalid) onApply(period, membership); }}>
    <ReportPopoverHeading title="Report period" status="Saved with report" />
    <label className="report-column-filter">Period<select value={reportPeriodChoice(period)} onChange={(event) => setPeriod(reportPeriodFromChoice(event.target.value, installationToday(catalog.timeZone), definition.period))}>{reportPeriodOptions.map(([value, label]) => value === "baseline" ? <option key={value} value={value} disabled={!baselineInfo?.startsOn}>{baselineInfo ? `${baselineInfo.label} baseline${baselineInfo.startsOn ? "" : " (not set)"}` : "Operational baseline"}</option> : <option key={value} value={value}>{label}</option>)}</select></label>
    {period.type === "fixed" && <><label className="report-column-filter">From<input type="date" aria-invalid={invalid || undefined} aria-describedby={invalid ? "report-date-error" : undefined} value={period.from} onChange={(event) => setPeriod({ ...period, from: event.target.value })} /></label><label className="report-column-filter">To<input type="date" min={period.from} aria-invalid={invalid || undefined} aria-describedby={invalid ? "report-date-error" : undefined} value={period.to} onChange={(event) => setPeriod({ ...period, to: event.target.value })} /></label></>}
    {invalid && <p id="report-date-error" className="ui-status" data-tone="error">Choose an end date on or after the start date.</p>}
    {baselineChoices.length > 1 && <><label className="report-column-filter">Baseline<select value={baselineInfo?.moduleId ?? ""} aria-describedby="report-baseline-help" onChange={(event) => setPeriod({ type: "baseline", module: event.target.value })}>{baselineChoices.map((item) => <option key={item.moduleId} value={item.moduleId} disabled={!item.startsOn}>{baselinePeriodText(item)}</option>)}</select></label><p id="report-baseline-help" className="report-filter-popover-help">This report has columns from more than one module, so one baseline sets the period for every column.</p></>}
    {unchanged && resolved?.from && definition.period.type !== "all" && <p className="report-filter-popover-help">{resolved.from} – {resolved.to} in the installation’s time zone.</p>}
    {offersMembership && <><label className="report-column-filter">Membership<select value={membership} aria-describedby="report-membership-help" onChange={(event) => setMembership(event.target.value as ReportDefinition["membership"])}><option value="current">Current membership</option><option value="historical">Historical membership</option></select></label><p id="report-membership-help" className="report-filter-popover-help">{membership === "current" ? "Current membership applies today’s labels throughout the report period." : "Historical membership uses labels held on each meeting date."} "Last N days" policy columns keep their configured membership and dates.</p></>}
    <ReportFilterActions canApply={!invalid} />
  </form>;
}

function ReportChevron() { return <svg className="report-disclosure-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" /></svg>; }

function ReportMenu({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  const details = useRef<HTMLDetailsElement | null>(null);
  useDismissableDetails(details);
  return <details className={`report-menu${icon ? " report-menu--icon" : ""}`} ref={details}><summary><span>{label}</span>{icon ?? <ReportChevron />}</summary><div className="report-menu-panel" onClick={(event) => { if ((event.target as Element).closest("button:not(:disabled)") && details.current) { details.current.open = false; details.current.querySelector("summary")?.focus(); } }}>{children}</div></details>;
}
