import { attendanceSetupInterval } from "./attendance-setup-interval";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import type { DashboardSetupProps } from "./module-contributions.ts";
import { ModuleRoot } from "./module-slots";
import { AddMemberForm } from "./roster-page";
import { RosterImportPanel } from "./roster-import-panel";
import { RouteLink } from "./router";
import type { RosterMember } from "./user-settings";

type SetupStep = ModuleSnapshotItem["setup"]["steps"][number] & { valid: boolean; outcome: "completed" | "skipped" | null; completedAt: string | null };
type SetupState = { moduleId: string; generation: number; ready: boolean; phase: string; version: number; steps: SetupStep[] };
// The Roster card is dashboard-only: the server records no outcome for it, and Verified attendance input already requires an active member.
type SetupCard = SetupStep & { local?: true };
type Rules = { lateScanMinutes: number; attendanceReportingStartsOn: string | null; anomalyLateThresholdMinutes: number; anomalyEarlyThresholdMinutes: number };
type Meeting = { id: string; title: string; startsAt: string; endsAt: string };
type InputState = { simulator: { name: string; active: number; online: number } | null; members: { id: string; label: string }[]; meetings: Meeting[] };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function readState(value: unknown, module: ModuleSnapshotItem): SetupState {
  if (!record(value) || value.moduleId !== module.id || value.generation !== module.generation || value.version !== module.setup.version || typeof value.ready !== "boolean" || value.phase !== "enabled" || !Array.isArray(value.steps) || value.steps.length !== module.setup.steps.length) throw new Error("Attendance setup state could not be verified. Reload setup.");
  const steps = value.steps.map((item, index) => {
    const expected = module.setup.steps[index];
    if (!record(item) || item.id !== expected?.id || item.label !== expected.label || item.required !== expected.required || typeof item.valid !== "boolean" || ![null, "completed", "skipped"].includes(item.outcome as string | null) || item.completedAt !== null && (typeof item.completedAt !== "string" || !Number.isFinite(Date.parse(item.completedAt)))) throw new Error("Attendance setup state could not be verified. Reload setup.");
    return item as SetupStep;
  });
  return { moduleId: module.id, generation: module.generation, ready: value.ready, phase: "enabled", version: module.setup.version, steps };
}

/** Setup cards in order, with the dashboard-only Roster card before Verified attendance input. A verified check-in already proves an active member exists. */
function setupCards(state: SetupState, activeMembers: number | undefined): SetupCard[] {
  return state.steps.flatMap((step): SetupCard[] => {
    if (step.id !== "input") return [step];
    const valid = Boolean(activeMembers) || step.valid;
    return [{ id: "roster", label: "Roster", required: true, valid, outcome: valid ? "completed" : null, completedAt: null, local: true }, step];
  });
}

const pendingCard = (cards: SetupCard[]) => cards.findIndex((step) => (step.required && !(step.valid && step.outcome === "completed")) || (!step.required && step.outcome === null));

function stepBadge(step: SetupCard): { tone: "success" | "neutral" | "warning"; text: string } {
  if (step.valid && (step.outcome === "completed" || !step.required)) return { tone: "success", text: "Complete" };
  if (!step.required) return { tone: "neutral", text: step.outcome === "skipped" ? "Not set up" : "Optional" };
  return step.valid ? { tone: "success", text: "Ready" } : { tone: "warning", text: "Action needed" };
}

// Setup times use minute precision; an unchanged default keeps its exact instant.
function localInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

// Meeting times are shown to the minute, like scan times elsewhere in the dashboard.
const meetingTime = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const meetingInstant = (value: string, original: string) => value === localInput(new Date(original)) ? original : new Date(value).toISOString();

function defaultMeeting(timeZone: string) {
  const interval = attendanceSetupInterval(Date.now(), timeZone);
  return { timeZone, originalStartsAt: interval.startsAt, originalEndsAt: interval.endsAt, title: "First Attendance meeting", startsAt: localInput(new Date(interval.startsAt)), endsAt: localInput(new Date(interval.endsAt)), required: true };
}

type ModuleSetupWorkspaceProps = DashboardSetupProps;

/** Lets a setup workspace tell the Core footer that every required step is saved, before the module snapshot refreshes. */
const RequiredStepsComplete = createContext<((complete: boolean) => void) | undefined>(undefined);

/** Render the guided setup contributed by the module being set up, inside its module root unless the Core shell owns it. Offer Finish setup later when the shell allows deferring it, or Close setup when it was reopened after completion. */
export function ModuleSetupWorkspace({ setup: Setup, moduleRoot = false, onFinishLater, onClose, ...props }: ModuleSetupWorkspaceProps & { setup?: React.ComponentType<DashboardSetupProps>; moduleRoot?: boolean; onFinishLater?: () => void; onClose?: () => void }) {
  const [requiredComplete, setRequiredComplete] = useState(false);
  const setup = !Setup ? <p className="ui-status" data-tone="error" role="alert">Module setup is unavailable.</p> : moduleRoot ? <ModuleRoot moduleId={props.module.id}><Setup {...props} /></ModuleRoot> : <Setup {...props} />;
  const workspace = <RequiredStepsComplete.Provider value={setRequiredComplete}>{setup}</RequiredStepsComplete.Provider>;
  if (onClose && !onFinishLater) return <>{workspace}<div className="module-setup-later"><button type="button" onClick={onClose} aria-describedby="module-setup-close-help">Close setup</button><p id="module-setup-close-help" className="field-help">{props.module.label} setup is complete. Saved steps stay as they are.</p></div></>;
  if (!onFinishLater) return workspace;
  return <>{workspace}<div className="module-setup-later"><button type="button" onClick={onFinishLater} aria-describedby="module-setup-later-help">Finish setup later</button><p id="module-setup-later-help" className="field-help">{requiredComplete ? `Every required step is complete, so ${props.module.label} is ready to use. You can set up the optional steps now or later.` : `Your saved steps are kept. ${props.module.label} becomes available once every required step is complete; continue from the notice at the top of any page.`}</p></div></>;
}

export function AttendanceSetupWorkspace({ module, navigate, onReady }: ModuleSetupWorkspaceProps) {
  const [state, setState] = useState<SetupState>();
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [finished, setFinished] = useState(false);
  const [rules, setRules] = useState<Rules>();
  const [storedRules, setStoredRules] = useState<Rules>();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meeting, setMeeting] = useState<ReturnType<typeof defaultMeeting>>();
  const [createAnotherMeeting, setCreateAnotherMeeting] = useState(false);
  const [input, setInput] = useState<InputState>();
  const [roster, setRoster] = useState<RosterMember[]>();
  const [simulatorName, setSimulatorName] = useState("Browser simulator");
  const [memberId, setMemberId] = useState("");
  const [meetingId, setMeetingId] = useState("");

  // An unreadable roster leaves the Roster card to the server-verified check-in instead of blocking setup.
  const readRoster = () => api<{ members: RosterMember[] }>("/admin/members").then((result) => result.members, () => undefined);
  const activeMembers = roster?.filter((member) => member.active).length;

  async function load() {
    setBusy(true); setNotice("");
    try {
      const [value, members] = await Promise.all([api<unknown>(`/admin/modules/${encodeURIComponent(module.id)}/setup`), readRoster()]);
      const next = readState(value, module);
      setState(next); setRoster(members);
      const pending = pendingCard(setupCards(next, members?.filter((member) => member.active).length));
      setCurrent(pending < 0 ? 0 : pending);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  useEffect(() => { void load(); }, [module.id, module.generation]);
  const cards = state ? setupCards(state, activeMembers) : [];
  const step = cards[current];

  function loadInput() {
    return api<InputState>("/module-setup/attendance/input").then((result) => { setInput(result); setMemberId((value) => result.members.some((item) => item.id === value) ? value : result.members[0]?.id ?? ""); setMeetingId(result.meetings[0]?.id ?? ""); }).catch((error: Error) => setNotice(error.message));
  }

  useEffect(() => {
    if (!step) return;
    setNotice("");
    if (step.id === "rules") void api<{ values: Rules }>("/module-setup/attendance/rules").then((result) => { setRules(result.values); setStoredRules(result.values); }).catch((error: Error) => setNotice(error.message));
    if (step.id === "meeting") void api<{ meetings: Meeting[]; timeZone: string }>("/module-setup/attendance/meeting").then((result) => { if (!result.timeZone) throw new Error("The organization time zone is unavailable. Reload setup."); setMeeting((current) => current ?? defaultMeeting(result.timeZone)); setMeetings(result.meetings); setMeetingId(result.meetings[0]?.id ?? ""); setCreateAnotherMeeting(false); }).catch((error: Error) => setNotice(error.message));
    if (step.id === "input") void loadInput();
  }, [step?.id]);

  const reportRequiredComplete = useContext(RequiredStepsComplete);
  useEffect(() => { reportRequiredComplete?.(Boolean(state?.ready)); }, [state?.ready]);

  async function rosterChanged() { setRoster(await readRoster()); }

  async function saveCurrent() {
    if (!state || !step) return;
    setBusy(true); setNotice("");
    try {
      if (step.local) {
        if (!step.valid) throw new Error("Add at least one active member before continuing.");
        setCurrent((index) => index + 1);
        return;
      }
      if (step.id === "rules") {
        if (!rules || !storedRules) throw new Error("Attendance rules are still loading.");
        await api("/module-setup/attendance/rules", { method: "PUT", body: JSON.stringify({ values: rules, expected: storedRules }) });
        setStoredRules(rules);
      } else if (step.id === "meeting" && (!meetings.length || createAnotherMeeting)) {
        if (!meeting) throw new Error("Meeting defaults are still loading. Try again.");
        const created = await api<{ id: string }>("/module-setup/attendance/meeting", { method: "POST", body: JSON.stringify({ title: meeting.title, startsAt: meetingInstant(meeting.startsAt, meeting.originalStartsAt), endsAt: meetingInstant(meeting.endsAt, meeting.originalEndsAt), required: meeting.required }) });
        setMeetingId(created.id);
        setCreateAnotherMeeting(false);
      } else if (step.id === "input" && !step.valid) {
        if (!memberId || !meetingId) throw new Error("Choose an active roster member and a meeting that is happening now.");
        await api("/module-setup/attendance/input", { method: "POST", body: JSON.stringify({ action: "start", name: simulatorName }) });
        await api("/module-setup/attendance/input", { method: "POST", body: JSON.stringify({ action: "scan", memberId, meetingId }) });
      }
      const outcome = step.required || step.valid ? "completed" : "skipped";
      const next = readState(await api<unknown>(`/admin/modules/${encodeURIComponent(module.id)}/setup`, { method: "PUT", body: JSON.stringify({ generation: module.generation, stepId: step.id, outcome }) }), module);
      setState(next);
      if (current < setupCards(next, activeMembers).length - 1) setCurrent((index) => index + 1);
      else if (next.ready) { await onReady(); setFinished(true); }
      else setNotice("Complete every required Attendance step before finishing setup.");
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  if (finished) return <AttendanceSetupComplete navigate={navigate} />;
  const required = cards.filter((item) => item.required);
  const requiredDone = required.filter((item) => item.valid && item.outcome === "completed").length;
  const badge = step ? stepBadge(step) : undefined;
  const rosterIndex = cards.findIndex((item) => item.id === "roster");
  return <section className="module-onboarding" aria-labelledby="module-setup-title">
    <div className="page-intro"><p className="kicker">Attendance module</p><h1 id="module-setup-title">Attendance setup</h1><p>Complete one card at a time. Optional integrations can be configured now or skipped and added later.</p></div>
    {notice && <p className="ui-status settings-notice" data-tone="error" role="alert">{notice}</p>}
    {!state && <p className="ui-status" role="status">{busy ? "Loading Attendance setup..." : "Attendance setup is unavailable."}</p>}
    {state && step && badge && <>
      <div className="module-setup-summary" role="status"><strong>Step {current + 1} of {cards.length}</strong><span>{requiredDone === required.length ? "Every required step is complete. Optional steps can be set up now or later." : `${requiredDone} of ${required.length} required steps complete`}</span></div>
      <article className="module-setup-card" aria-labelledby={`module-step-${step.id}`}>
        <div className="module-setup-card-heading"><div><p className="kicker">Step {current + 1} - {step.required ? "Required" : "Optional"}</p><h2 id={`module-step-${step.id}`}>{step.label}</h2></div><span className="ui-status" data-tone={badge.tone}>{badge.text}</span></div>
        {step.id === "rules" && <RulesStep value={rules} onChange={setRules} />}
        {step.id === "meeting" && <MeetingStep meetings={meetings} value={meeting} onChange={setMeeting} createAnother={createAnotherMeeting} onCreateAnother={setCreateAnotherMeeting} />}
        {step.id === "roster" && <RosterStep members={roster} onChanged={rosterChanged} />}
        {step.id === "input" && <InputStep state={input} simulatorName={simulatorName} setSimulatorName={setSimulatorName} memberId={memberId} setMemberId={setMemberId} meetingId={meetingId} setMeetingId={setMeetingId} onOpenRoster={() => setCurrent(rosterIndex)} onOpenMeeting={() => setCurrent(cards.findIndex((item) => item.id === "meeting"))} valid={step.valid} />}
        {step.id === "calendar" && <IntegrationStep provider="Google Calendar" valid={step.valid} navigate={navigate} />}
        {step.id === "discord" && <IntegrationStep provider="Discord" valid={step.valid} navigate={navigate} />}
        <div className="module-actions"><button type="button" disabled={busy || current === 0} onClick={() => setCurrent((index) => index - 1)}>Back</button><button className="primary-button" type="button" disabled={busy || step.id === "meeting" && !meeting || step.local && !step.valid} onClick={() => void saveCurrent()}>{busy ? "Saving..." : step.local ? "Continue" : !step.required && !step.valid ? "Set up later and continue" : current === cards.length - 1 ? "Finish Attendance setup" : "Save and continue"}</button></div>
      </article>
    </>}
    {!state && !busy && <button type="button" onClick={() => void load()}>Try again</button>}
  </section>;
}

const nextSteps: { href: string; label: string; detail: string }[] = [
  { href: "/kiosks", label: "Pair a kiosk", detail: "Install the kiosk software on a Raspberry Pi so members can check in on their own. Open Kiosks and choose Add kiosk." },
  { href: "/roster", label: "Add or import members", detail: "Add the rest of your members one at a time, or import a CSV file, in Roster." },
  { href: "/settings/access", label: "Invite other Admins", detail: "Give other staff their own dashboard accounts in Settings > Access." },
  { href: "/settings/integrations", label: "Connect Google Calendar or Discord", detail: "Import meetings and share attendance updates from Settings > Integrations." },
  { href: "/settings/updates", label: "Set up dashboard updates", detail: "Choose how this dashboard receives new releases in Settings > Updates." },
];

function AttendanceSetupComplete({ navigate }: { navigate: (path: string) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { window.requestAnimationFrame(() => heading.current?.focus()); }, []);
  return <section className="module-onboarding module-setup-complete" aria-labelledby="module-setup-complete-title">
    <div className="page-intro"><p className="kicker">Attendance setup</p><h1 id="module-setup-complete-title" ref={heading} tabIndex={-1}>Attendance is ready</h1><p>Meetings, check-ins, and attendance reports are now available. These next steps are optional and can be done in any order.</p></div>
    <ul className="module-next-steps" aria-label="Next steps">{nextSteps.map((item) => <li key={item.href}><RouteLink href={item.href} currentPath="" navigate={navigate}>{item.label}</RouteLink><p>{item.detail}</p></li>)}</ul>
    <div className="module-actions"><RouteLink className="primary-button action-link" href="/dashboard" currentPath="" navigate={navigate}>Go to Meetings</RouteLink></div>
  </section>;
}

function RulesStep({ value, onChange }: { value?: Rules; onChange: (value: Rules) => void }) {
  if (!value) return <p role="status">Loading current Attendance rules...</p>;
  return <div className="form-grid module-setup-rules">
    <div className="module-setup-field"><label htmlFor="setup-late-scan">Late scan minutes<input id="setup-late-scan" type="number" min={0} max={180} step={1} value={value.lateScanMinutes} aria-describedby="setup-late-scan-help" onChange={(event) => onChange({ ...value, lateScanMinutes: Number(event.target.value) })} /></label><p id="setup-late-scan-help" className="field-help">How many minutes after a meeting ends check-ins are still accepted, from 0 to 180. Example: with 30, a meeting that ends at 5:00 PM accepts scans until 5:30 PM.</p></div>
    <div className="module-setup-field"><label htmlFor="setup-reporting-start">Reporting starts on <span>(optional)</span><input id="setup-reporting-start" type="date" value={value.attendanceReportingStartsOn ?? ""} aria-describedby="setup-reporting-start-help" onChange={(event) => onChange({ ...value, attendanceReportingStartsOn: event.target.value || null })} /></label><p id="setup-reporting-start-help" className="field-help">Reports count completed meetings on or after this date. Leave it blank to include all history.</p></div>
    <div className="module-setup-field"><label htmlFor="setup-late-anomaly">Late anomaly threshold (minutes)<input id="setup-late-anomaly" type="number" min={0} max={180} step={1} value={value.anomalyLateThresholdMinutes} aria-describedby="setup-late-anomaly-help" onChange={(event) => onChange({ ...value, anomalyLateThresholdMinutes: Number(event.target.value) })} /></label><p id="setup-late-anomaly-help" className="field-help">A check-in more than this many minutes after the meeting starts is flagged as a late arrival in anomaly reports. Example: with 10, checking in at 4:11 PM for a 4:00 PM meeting is flagged.</p></div>
    <div className="module-setup-field"><label htmlFor="setup-early-anomaly">Early anomaly threshold (minutes)<input id="setup-early-anomaly" type="number" min={0} max={180} step={1} value={value.anomalyEarlyThresholdMinutes} aria-describedby="setup-early-anomaly-help" onChange={(event) => onChange({ ...value, anomalyEarlyThresholdMinutes: Number(event.target.value) })} /></label><p id="setup-early-anomaly-help" className="field-help">A check-out more than this many minutes before the meeting ends is flagged as an early departure in anomaly reports. Example: with 10, checking out at 4:49 PM from a meeting that ends at 5:00 PM is flagged.</p></div>
  </div>;
}

function MeetingStep({ meetings, value, onChange, createAnother, onCreateAnother }: { meetings: Meeting[]; value?: ReturnType<typeof defaultMeeting>; onChange: (value: ReturnType<typeof defaultMeeting>) => void; createAnother: boolean; onCreateAnother: (value: boolean) => void }) {
  if (!value) return <p role="status">Loading meeting defaults...</p>;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const form = <><p>Create a test meeting that is happening now, so you can record a check-in in the next step. The times below already work; change them only if you need to.</p><p className="field-help" id="setup-meeting-times-help">Times are in your browser time zone ({browserZone}). A meeting must start and end on the same day{browserZone === value.timeZone ? "" : ` in the organization time zone (${value.timeZone})`}.</p><label htmlFor="setup-meeting-title">Meeting title<input id="setup-meeting-title" maxLength={120} value={value.title} onChange={(event) => onChange({ ...value, title: event.target.value })} /></label><div className="form-grid"><label htmlFor="setup-meeting-starts">Starts<input id="setup-meeting-starts" type="datetime-local" step={60} value={value.startsAt} aria-describedby="setup-meeting-times-help" onChange={(event) => onChange({ ...value, startsAt: event.target.value })} /></label><label htmlFor="setup-meeting-ends">Ends<input id="setup-meeting-ends" type="datetime-local" step={60} value={value.endsAt} aria-describedby="setup-meeting-times-help" onChange={(event) => onChange({ ...value, endsAt: event.target.value })} /></label></div><label className="checkbox-field"><input type="checkbox" checked={value.required} onChange={(event) => onChange({ ...value, required: event.target.checked })} /> Required meeting</label></>;
  if (meetings.length) return <div><p>{meetings.length} existing meeting{meetings.length === 1 ? " is" : "s are"} available. Continue with the current schedule, or replace an unsuitable first choice by creating a different meeting now.</p><ul className="compact-list">{meetings.slice(0, 3).map((item) => <li key={item.id}><strong>{item.title}</strong> - {meetingTime(item.startsAt)}</li>)}</ul><label className="checkbox-field"><input type="checkbox" checked={createAnother} onChange={(event) => onCreateAnother(event.target.checked)} /> Create a different meeting before continuing</label>{createAnother && form}</div>;
  return <div>{form}</div>;
}

function RosterStep({ members, onChanged }: { members?: RosterMember[]; onChanged: () => Promise<void> }) {
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState("");
  const active = members?.filter((member) => member.active) ?? [];
  const importButton = <button type="button" onClick={() => setImporting(true)}>Import CSV</button>;
  return <div className="module-setup-roster">
    <p>Add at least one person to the roster so the next step can record a test check-in. You can add everyone else later in Roster.</p>
    {added && <p className="ui-status" data-tone="success" role="status">{added}</p>}
    {active.length > 0 && <p>{active.length} active member{active.length === 1 ? " is" : "s are"} on the roster{active.length <= 3 ? `: ${active.map((member) => `${member.firstName} ${member.lastName}`).join(", ")}` : ""}.</p>}
    {active.length > 0 && !adding ? <div className="module-actions"><button type="button" onClick={() => setAdding(true)}>Add another member</button>{importButton}</div>
      : <AddMemberForm idPrefix="setup-member" compact members={members ?? []} attendanceEnabled={false} onAdded={async () => { await onChanged(); setAdded("Roster member added."); setAdding(false); }} secondaryAction={importButton} />}
    <RosterImportPanel open={importing} onClose={() => setImporting(false)} members={members ?? []} onImported={async () => { await onChanged(); setAdded("Roster imported."); }} />
  </div>;
}

function InputStep({ state, simulatorName, setSimulatorName, memberId, setMemberId, meetingId, setMeetingId, onOpenRoster, onOpenMeeting, valid }: { state?: InputState; simulatorName: string; setSimulatorName: (value: string) => void; memberId: string; setMemberId: (value: string) => void; meetingId: string; setMeetingId: (value: string) => void; onOpenRoster: () => void; onOpenMeeting: () => void; valid: boolean }) {
  const kiosks = <p className="field-help">Using a physical kiosk? Pair it from Kiosks once setup is finished. A kiosk can only connect after Attendance is ready, so this step uses the browser simulator.</p>;
  if (valid) return <div><p>A kiosk or browser simulator check-in has been verified. Continue to optional integrations.</p>{kiosks}</div>;
  if (!state) return <p role="status">Loading browser simulator choices...</p>;
  return <div><p>Record a test check-in with the browser simulator. It uses the real attendance rules and server time. It does not test or store fingerprint data.</p><label htmlFor="setup-simulator-name">Simulator name<input id="setup-simulator-name" maxLength={80} value={simulatorName} onChange={(event) => setSimulatorName(event.target.value)} /></label>{state.members.length ? <label htmlFor="setup-input-member">Roster member<select id="setup-input-member" value={memberId} onChange={(event) => setMemberId(event.target.value)}>{state.members.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label> : <p className="warning-callout">No active members yet. Add one in the <button type="button" className="link-button" onClick={onOpenRoster}>Roster step</button>.</p>}{state.meetings.length ? <label htmlFor="setup-input-meeting">Meeting happening now<select id="setup-input-meeting" value={meetingId} onChange={(event) => setMeetingId(event.target.value)}>{state.meetings.map((item) => <option key={item.id} value={item.id}>{item.title} - {meetingTime(item.startsAt)}</option>)}</select></label> : <p className="warning-callout">No meetings yet. Create one in the <button type="button" className="link-button" onClick={onOpenMeeting}>First meeting step</button>.</p>}{kiosks}</div>;
}

function IntegrationStep({ provider, valid, navigate }: { provider: string; valid: boolean; navigate: (path: string) => void }) {
  return <div><p>{valid ? `${provider} is configured and verified for this installation.` : `${provider} is not configured and verified. You can safely set it up later.`}</p><button type="button" className="quiet-button" onClick={() => navigate("/settings/integrations")}>Open Integrations settings</button></div>;
}
