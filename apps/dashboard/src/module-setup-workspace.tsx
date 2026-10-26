import { attendanceSetupInterval } from "./attendance-setup-interval";
import { useEffect, useState } from "react";
import type { ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import { OutreachSetupWorkspace } from "./outreach-setup-workspace";
import { CarpoolSetupWorkspace } from "./carpool-setup-workspace";

type SetupStep = ModuleSnapshotItem["setup"]["steps"][number] & { valid: boolean; outcome: "completed" | "skipped" | null; completedAt: string | null };
type SetupState = { moduleId: string; generation: number; ready: boolean; phase: string; version: number; steps: SetupStep[] };
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

function localInput(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, -1);
}

const meetingInstant = (value: string, original: string) => value === localInput(new Date(original)) ? original : new Date(value).toISOString();

function defaultMeeting(timeZone: string) {
  const interval = attendanceSetupInterval(Date.now(), timeZone);
  return { timeZone, originalStartsAt: interval.startsAt, originalEndsAt: interval.endsAt, title: "First Attendance meeting", startsAt: localInput(new Date(interval.startsAt)), endsAt: localInput(new Date(interval.endsAt)), required: true };
}

type ModuleSetupWorkspaceProps = { module: ModuleSnapshotItem; navigate: (path: string) => void; onReady: () => Promise<void> | void };

export function ModuleSetupWorkspace(props: ModuleSetupWorkspaceProps) {
  const renderers: Record<string, (input: ModuleSetupWorkspaceProps) => React.ReactNode> = {
    attendance: (input) => <AttendanceSetupWorkspace {...input} />,
    "hour-tracking": (input) => <OutreachSetupWorkspace {...input} />,
    carpool: (input) => <CarpoolSetupWorkspace {...input} />,
  };
  return renderers[props.module.id]?.(props) ?? <p className="ui-status" data-tone="error" role="alert">Module setup is unavailable.</p>;
}

function AttendanceSetupWorkspace({ module, navigate, onReady }: ModuleSetupWorkspaceProps) {
  const [state, setState] = useState<SetupState>();
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [rules, setRules] = useState<Rules>();
  const [storedRules, setStoredRules] = useState<Rules>();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meeting, setMeeting] = useState<ReturnType<typeof defaultMeeting>>();
  const [createAnotherMeeting, setCreateAnotherMeeting] = useState(false);
  const [input, setInput] = useState<InputState>();
  const [simulatorName, setSimulatorName] = useState("Browser simulator");
  const [memberId, setMemberId] = useState("");
  const [meetingId, setMeetingId] = useState("");

  async function load() {
    setBusy(true); setNotice("");
    try {
      const next = readState(await api<unknown>(`/admin/modules/${encodeURIComponent(module.id)}/setup`), module);
      setState(next);
      const pending = next.steps.findIndex((step) => (step.required && !(step.valid && step.outcome === "completed")) || (!step.required && step.outcome === null));
      setCurrent(pending < 0 ? 0 : pending);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  useEffect(() => { void load(); }, [module.id, module.generation]);
  const step = state?.steps[current];

  useEffect(() => {
    if (!step) return;
    setNotice("");
    if (step.id === "rules") void api<{ values: Rules }>("/module-setup/attendance/rules").then((result) => { setRules(result.values); setStoredRules(result.values); }).catch((error: Error) => setNotice(error.message));
    if (step.id === "meeting") void api<{ meetings: Meeting[]; timeZone: string }>("/module-setup/attendance/meeting").then((result) => { if (!result.timeZone) throw new Error("The organization time zone is unavailable. Reload setup."); setMeeting((current) => current ?? defaultMeeting(result.timeZone)); setMeetings(result.meetings); setMeetingId(result.meetings[0]?.id ?? ""); setCreateAnotherMeeting(false); }).catch((error: Error) => setNotice(error.message));
    if (step.id === "input") void api<InputState>("/module-setup/attendance/input").then((result) => { setInput(result); setMemberId(result.members[0]?.id ?? ""); setMeetingId(result.meetings[0]?.id ?? ""); }).catch((error: Error) => setNotice(error.message));
  }, [step?.id]);

  async function saveCurrent() {
    if (!state || !step) return;
    setBusy(true); setNotice("");
    try {
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
        if (!memberId || !meetingId) throw new Error("Choose an active roster member and a meeting whose attendance window is open now.");
        await api("/module-setup/attendance/input", { method: "POST", body: JSON.stringify({ action: "start", name: simulatorName }) });
        await api("/module-setup/attendance/input", { method: "POST", body: JSON.stringify({ action: "scan", memberId, meetingId }) });
      }
      const outcome = step.required || step.valid ? "completed" : "skipped";
      const next = readState(await api<unknown>(`/admin/modules/${encodeURIComponent(module.id)}/setup`, { method: "PUT", body: JSON.stringify({ generation: module.generation, stepId: step.id, outcome }) }), module);
      setState(next);
      if (current < next.steps.length - 1) setCurrent((index) => index + 1);
      else if (next.ready) { await onReady(); navigate("/dashboard"); }
      else setNotice("Complete every required Attendance step before finishing setup.");
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  const completed = state?.steps.filter((item) => (item.outcome === "completed" && item.valid) || item.outcome === "skipped").length ?? 0;
  return <section className="module-onboarding" aria-labelledby="module-setup-title">
    <div className="page-intro"><p className="kicker">Attendance module</p><h1 id="module-setup-title">Set up Attendance</h1><p>Complete one card at a time. Optional integrations can be configured now or skipped and added later.</p></div>
    {notice && <p className="ui-status settings-notice" data-tone="error" role="alert">{notice}</p>}
    {!state && <p className="ui-status" role="status">{busy ? "Loading Attendance setup..." : "Attendance setup is unavailable."}</p>}
    {state && step && <>
      <div className="module-setup-summary" role="status"><strong>{state.ready ? "Setup complete" : "Setup required"}</strong><span>Step {current + 1} of {state.steps.length} - {completed} recorded</span></div>
      <article className="module-setup-card" aria-labelledby={`module-step-${step.id}`}>
        <div className="module-setup-card-heading"><div><p className="kicker">Step {current + 1} - {step.required ? "Required" : "Optional"}</p><h2 id={`module-step-${step.id}`}>{step.label}</h2></div><span className="ui-status" data-tone={step.valid && step.outcome === "completed" || step.outcome === "skipped" ? "success" : step.valid ? "neutral" : "warning"}>{step.outcome === "skipped" ? "Set up later" : step.valid && step.outcome === "completed" ? "Complete" : step.valid ? "Ready" : "Action needed"}</span></div>
        {step.id === "rules" && <RulesStep value={rules} onChange={setRules} />}
        {step.id === "meeting" && <MeetingStep meetings={meetings} value={meeting} onChange={setMeeting} createAnother={createAnotherMeeting} onCreateAnother={setCreateAnotherMeeting} />}
        {step.id === "input" && <InputStep state={input} simulatorName={simulatorName} setSimulatorName={setSimulatorName} memberId={memberId} setMemberId={setMemberId} meetingId={meetingId} setMeetingId={setMeetingId} navigate={navigate} valid={step.valid} />}
        {step.id === "calendar" && <IntegrationStep provider="Google Calendar" valid={step.valid} navigate={navigate} />}
        {step.id === "discord" && <IntegrationStep provider="Discord" valid={step.valid} navigate={navigate} />}
        <div className="module-actions"><button type="button" disabled={busy || current === 0} onClick={() => setCurrent((index) => index - 1)}>Back</button><button className="primary-button" type="button" disabled={busy || step.id === "meeting" && !meeting} onClick={() => void saveCurrent()}>{busy ? "Saving..." : !step.required && !step.valid ? "Set up later and continue" : current === state.steps.length - 1 ? "Finish Attendance setup" : "Save and continue"}</button></div>
      </article>
    </>}
    {!state && !busy && <button type="button" onClick={() => void load()}>Try again</button>}
  </section>;
}

function RulesStep({ value, onChange }: { value?: Rules; onChange: (value: Rules) => void }) {
  if (!value) return <p role="status">Loading current Attendance rules...</p>;
  return <div className="form-grid"><label>Late scan minutes<input type="number" min={0} max={180} value={value.lateScanMinutes} onChange={(event) => onChange({ ...value, lateScanMinutes: Number(event.target.value) })} /></label><label>Reporting starts on <span>(optional)</span><input type="date" value={value.attendanceReportingStartsOn ?? ""} onChange={(event) => onChange({ ...value, attendanceReportingStartsOn: event.target.value || null })} /></label><label>Late anomaly threshold<input type="number" min={0} max={180} value={value.anomalyLateThresholdMinutes} onChange={(event) => onChange({ ...value, anomalyLateThresholdMinutes: Number(event.target.value) })} /></label><label>Early anomaly threshold<input type="number" min={0} max={180} value={value.anomalyEarlyThresholdMinutes} onChange={(event) => onChange({ ...value, anomalyEarlyThresholdMinutes: Number(event.target.value) })} /></label></div>;
}

function MeetingStep({ meetings, value, onChange, createAnother, onCreateAnother }: { meetings: Meeting[]; value?: ReturnType<typeof defaultMeeting>; onChange: (value: ReturnType<typeof defaultMeeting>) => void; createAnother: boolean; onCreateAnother: (value: boolean) => void }) {
  if (!value) return <p role="status">Loading meeting defaults...</p>;
  const form = <><p>Create a meeting whose attendance window is open now and whose start and end share one date in {value.timeZone}. Times below are shown in your browser time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p><label>Meeting title<input maxLength={120} value={value.title} onChange={(event) => onChange({ ...value, title: event.target.value })} /></label><div className="form-grid"><label>Starts<input type="datetime-local" step="0.001" value={value.startsAt} onChange={(event) => onChange({ ...value, startsAt: event.target.value })} /></label><label>Ends<input type="datetime-local" step="0.001" value={value.endsAt} onChange={(event) => onChange({ ...value, endsAt: event.target.value })} /></label></div><label className="checkbox-field"><input type="checkbox" checked={value.required} onChange={(event) => onChange({ ...value, required: event.target.checked })} /> Required meeting</label></>;
  if (meetings.length) return <div><p>{meetings.length} existing meeting{meetings.length === 1 ? " is" : "s are"} available. Continue with the current schedule, or replace an unsuitable first choice by creating a different meeting now.</p><ul className="compact-list">{meetings.slice(0, 3).map((item) => <li key={item.id}><strong>{item.title}</strong> - {new Date(item.startsAt).toLocaleString()}</li>)}</ul><label className="checkbox-field"><input type="checkbox" checked={createAnother} onChange={(event) => onCreateAnother(event.target.checked)} /> Create a different meeting before continuing</label>{createAnother && form}</div>;
  return <div>{form}</div>;
}

function InputStep({ state, simulatorName, setSimulatorName, memberId, setMemberId, meetingId, setMeetingId, navigate, valid }: { state?: InputState; simulatorName: string; setSimulatorName: (value: string) => void; memberId: string; setMemberId: (value: string) => void; meetingId: string; setMeetingId: (value: string) => void; navigate: (path: string) => void; valid: boolean }) {
  if (valid) return <p>A kiosk or browser simulator check-in has been verified. Continue to optional integrations.</p>;
  if (!state) return <p role="status">Loading browser simulator choices...</p>;
  return <div><p>The browser simulator records a real server-timed check-in. It does not test or store fingerprint data.</p><label>Simulator name<input maxLength={80} value={simulatorName} onChange={(event) => setSimulatorName(event.target.value)} /></label>{state.members.length ? <label>Roster member<select value={memberId} onChange={(event) => setMemberId(event.target.value)}>{state.members.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label> : <p className="warning-callout">Add an active member in <button type="button" className="link-button" onClick={() => navigate("/roster")}>Roster</button>, then return to setup.</p>}{state.meetings.length ? <label>Meeting with an open attendance window<select value={meetingId} onChange={(event) => setMeetingId(event.target.value)}>{state.meetings.map((item) => <option key={item.id} value={item.id}>{item.title} - {new Date(item.startsAt).toLocaleString()}</option>)}</select></label> : <p className="warning-callout">Return to the previous step and create a meeting.</p>}</div>;
}

function IntegrationStep({ provider, valid, navigate }: { provider: string; valid: boolean; navigate: (path: string) => void }) {
  return <div><p>{valid ? `${provider} is configured and verified for this installation.` : `${provider} is not configured and verified. You can safely set it up later.`}</p><button type="button" className="quiet-button" onClick={() => navigate("/settings/integrations")}>Open Integrations settings</button></div>;
}
