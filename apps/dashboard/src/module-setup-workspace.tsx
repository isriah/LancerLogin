import { attendanceSetupInterval } from "./attendance-setup-interval";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import type { DashboardSetupProps } from "./module-contributions.ts";
import { ModuleRoot } from "./module-slots";
import { PairKioskDialog } from "./pair-kiosk-dialog";
import { AddMemberForm } from "./roster-page";
import { RosterImportPanel } from "./roster-import-panel";
import { RouteLink } from "./router";
import type { RosterMember } from "./user-settings";

type SetupStep = ModuleSnapshotItem["setup"]["steps"][number] & { valid: boolean; outcome: "completed" | "skipped" | null; completedAt: string | null };
type SetupState = { moduleId: string; generation: number; ready: boolean; phase: string; version: number; steps: SetupStep[] };
// The Roster card is dashboard-only: the server records no outcome for it.
type SetupCard = SetupStep & { local?: true };
type Rules = { lateScanMinutes: number; attendanceReportingStartsOn: string | null; anomalyLateThresholdMinutes: number; anomalyEarlyThresholdMinutes: number };
type Meeting = { id: string; title: string; startsAt: string; endsAt: string };
type SetupKiosk = { id: string; name: string; kind: "pi" | "web"; lastSeenAt: string | null };
type InputState = { kiosks: SetupKiosk[] };
// While the Verified attendance input card waits for a newly paired kiosk to check in.
const kioskCheckInPollMs = 5000;

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

/** Setup cards in order, with the dashboard-only Roster card before Verified attendance input. An unreadable roster does not block setup. */
function setupCards(state: SetupState, activeMembers: number | undefined): SetupCard[] {
  return state.steps.flatMap((step): SetupCard[] => {
    if (step.id !== "input") return [step];
    const valid = activeMembers === undefined || activeMembers > 0;
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
  const [pairing, setPairing] = useState(false);

  // An unreadable roster leaves the Roster card complete instead of blocking setup; Roster is available after setup.
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
    return api<InputState>("/module-setup/attendance/input").then((result) => { setInput(result); return result; }, (error: Error) => { setNotice(error.message); return undefined; });
  }

  /** Rereads the kiosks and, once one has checked in, the setup state, so the card turns Ready without a reload. */
  async function refreshInput() {
    const result = await loadInput();
    if (!result?.kiosks.some((kiosk) => kiosk.lastSeenAt)) return;
    try { setState(readState(await api<unknown>(`/admin/modules/${encodeURIComponent(module.id)}/setup`), module)); }
    catch (error) { setNotice((error as Error).message); }
  }

  useEffect(() => {
    if (!step) return;
    setNotice("");
    if (step.id === "rules") void api<{ values: Rules }>("/module-setup/attendance/rules").then((result) => { setRules(result.values); setStoredRules(result.values); }).catch((error: Error) => setNotice(error.message));
    if (step.id === "meeting") void api<{ meetings: Meeting[]; timeZone: string }>("/module-setup/attendance/meeting").then((result) => { if (!result.timeZone) throw new Error("The organization time zone is unavailable. Reload setup."); setMeeting((current) => current ?? defaultMeeting(result.timeZone)); setMeetings(result.meetings); setCreateAnotherMeeting(false); }).catch((error: Error) => setNotice(error.message));
    if (step.id === "input") void loadInput();
  }, [step?.id]);

  // A kiosk checks in within seconds of pairing; keep looking while this card waits for one.
  const waitingForKiosk = step?.id === "input" && !step.valid;
  useEffect(() => {
    if (!waitingForKiosk) return;
    const timer = window.setInterval(() => void refreshInput(), kioskCheckInPollMs);
    return () => window.clearInterval(timer);
  }, [waitingForKiosk]);

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
      if (step.id === "input" && !step.valid) {
        const kiosks = (await loadInput())?.kiosks ?? [];
        if (!kiosks.some((kiosk) => kiosk.lastSeenAt)) throw new Error(kiosks.length ? "Wait for the paired kiosk to check in, then continue. A kiosk checks in within a minute of pairing." : "Pair a kiosk with Add kiosk, then continue once it checks in.");
      }
      if (step.id === "rules") {
        if (!rules || !storedRules) throw new Error("Attendance rules are still loading.");
        await api("/module-setup/attendance/rules", { method: "PUT", body: JSON.stringify({ values: rules, expected: storedRules }) });
        setStoredRules(rules);
      } else if (step.id === "meeting" && (!meetings.length || createAnotherMeeting)) {
        if (!meeting) throw new Error("Meeting defaults are still loading. Try again.");
        await api<{ id: string }>("/module-setup/attendance/meeting", { method: "POST", body: JSON.stringify({ title: meeting.title, startsAt: meetingInstant(meeting.startsAt, meeting.originalStartsAt), endsAt: meetingInstant(meeting.endsAt, meeting.originalEndsAt), required: meeting.required }) });
        setCreateAnotherMeeting(false);
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
        {step.id === "input" && <InputStep state={input} valid={step.valid} setupComplete={state.ready} onAddKiosk={() => setPairing(true)} onRefresh={() => void refreshInput()} navigate={navigate} />}
        {step.id === "calendar" && <IntegrationStep provider="Google Calendar" valid={step.valid} navigate={navigate} />}
        {step.id === "discord" && <IntegrationStep provider="Discord" valid={step.valid} navigate={navigate} />}
        <div className="module-actions"><button type="button" disabled={busy || current === 0} onClick={() => setCurrent((index) => index - 1)}>Back</button><button className="primary-button" type="button" disabled={busy || step.id === "meeting" && !meeting || step.local && !step.valid} onClick={() => void saveCurrent()}>{busy ? "Saving..." : step.local ? "Continue" : !step.required && !step.valid ? "Set up later and continue" : current === cards.length - 1 ? "Finish Attendance setup" : "Save and continue"}</button></div>
      </article>
    </>}
    {!state && !busy && <button type="button" onClick={() => void load()}>Try again</button>}
    {pairing && <PairKioskDialog onClose={() => setPairing(false)} onPaired={refreshInput} />}
  </section>;
}

const nextSteps: { href: string; label: string; detail: string }[] = [
  { href: "/kiosks", label: "Add more kiosks", detail: "Pair another Raspberry Pi or web kiosk so members can check in at more places. Open Kiosks and choose Add kiosk." },
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
    <p>Add at least one person to the roster so they can check in at the kiosk you pair next. You can add everyone else later in Roster.</p>
    {added && <p className="ui-status" data-tone="success" role="status">{added}</p>}
    {active.length > 0 && <p>{active.length} active member{active.length === 1 ? " is" : "s are"} on the roster{active.length <= 3 ? `: ${active.map((member) => `${member.firstName} ${member.lastName}`).join(", ")}` : ""}.</p>}
    {active.length > 0 && !adding ? <div className="module-actions"><button type="button" onClick={() => setAdding(true)}>Add another member</button>{importButton}</div>
      : <AddMemberForm idPrefix="setup-member" compact members={members ?? []} attendanceEnabled={false} onAdded={async () => { await onChanged(); setAdded("Roster member added."); setAdding(false); }} secondaryAction={importButton} />}
    <RosterImportPanel open={importing} onClose={() => setImporting(false)} members={members ?? []} onImported={async () => { await onChanged(); setAdded("Roster imported."); }} />
  </div>;
}

const lastSeen = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Verified attendance input: pair a kiosk and wait for it to check in. Kiosks opens once setup is finished, so this card pairs with the same Add kiosk dialog. */
function InputStep({ state, valid, setupComplete, onAddKiosk, onRefresh, navigate }: { state?: InputState; valid: boolean; setupComplete: boolean; onAddKiosk: () => void; onRefresh: () => void; navigate: (path: string) => void }) {
  const kiosks = state?.kiosks ?? [];
  const waiting = kiosks.filter((kiosk) => !kiosk.lastSeenAt);
  return <div className="module-setup-input">
    <p>Pair a kiosk: a Raspberry Pi with a fingerprint reader, or a touchscreen laptop or tablet as a web kiosk. Add kiosk here opens the same dialog as Kiosks &gt; Add kiosk. This step is complete once the kiosk checks in, usually within a minute of pairing.</p>
    {!state ? <p role="status">Loading paired kiosks...</p> : kiosks.length ? <ul className="compact-list" aria-label="Paired kiosks">{kiosks.map((kiosk) => <li key={kiosk.id}><strong>{kiosk.name}</strong> ({kiosk.kind === "web" ? "web kiosk" : "Raspberry Pi"}) - {kiosk.lastSeenAt ? `checked in ${lastSeen(kiosk.lastSeenAt)}` : "waiting for its first check-in"}</li>)}</ul> : <p>No kiosk is paired yet.</p>}
    {valid ? <p className="ui-status" data-tone="success" role="status">A paired kiosk has checked in. Continue to the optional integrations.</p> : waiting.length > 0 && <p className="field-help" role="status">Waiting for {waiting.map((kiosk) => kiosk.name).join(", ")} to check in. This card updates on its own.</p>}
    <div className="module-actions"><button type="button" className={valid ? undefined : "primary-button"} onClick={onAddKiosk}>Add kiosk</button>{!valid && state && <button type="button" onClick={onRefresh}>Check again</button>}{setupComplete && <button type="button" className="quiet-button" onClick={() => navigate("/kiosks")}>Open Kiosks</button>}</div>
  </div>;
}

function IntegrationStep({ provider, valid, navigate }: { provider: string; valid: boolean; navigate: (path: string) => void }) {
  return <div><p>{valid ? `${provider} is configured and verified for this installation.` : `${provider} is not configured and verified. You can safely set it up later.`}</p><button type="button" className="quiet-button" onClick={() => navigate("/settings/integrations")}>Open Integrations settings</button></div>;
}
