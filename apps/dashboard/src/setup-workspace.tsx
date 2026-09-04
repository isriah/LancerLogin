import { FormEvent, ReactNode, useEffect, useState } from "react";
import { AdaptiveBrandLogo, type LogoBackdrop } from "./adaptive-brand-logo";
import { ColorEditor } from "./color-editor";
import { RosterImportPanel } from "./roster-import-panel";
import type { RosterMember } from "./user-settings";
import { hardwarePairingKey, kioskInstallerUrl } from "./hardware-pairing-key";
import { useDashboardLoadingOverlay } from "./loading-overlay";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const steps = [
  ["branding", "Organization & brand", "Choose the name and appearance people will see."],
  ["roster", "Roster", "Import the people who can attend. Discord is not required."],
  ["pair-kiosk", "Kiosk", "Pair hardware or the browser simulator with a one-time code."],
  ["fingerprint-test", "Kiosk input test", "Test the reader on hardware or a member selection in the simulator."],
  ["confirm-attendance", "Attendance confirmation", "Confirm the expected check-in reached the dashboard."],
] as const;
type StepId = typeof steps[number][0];
export type Branding = { organizationName: string; subtitle?: string; logoData?: string; primaryColor: string; secondaryColor: string; appearance: "system" | "light" | "dark"; logoBackdrop: LogoBackdrop; lateScanMinutes: number; discordContestWindowHours: number; attendanceReportingStartsOn?: string | null };
type Member = RosterMember;
type Kiosk = { id: string; name: string; active: number; lastSeenAt?: string; pairedAt: string };
type Meeting = { id: string; title: string; startsAt: string; endsAt: string };
type Simulator = { name: string; active: number; online: number; lastSeenAt?: string; pairedAt: string; readerOnline: false; releaseVersion: string };
type AttendanceRow = { memberId: string; externalId: string; firstName: string; lastName: string; disposition: "present" | "absent" | "excused" };
const setupStepIds = steps.map(([id]) => id);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await result.json() as T & { error?: string; details?: string[] };
  if (!result.ok) throw new Error(body.details?.join(" ") ?? body.error ?? "Request failed");
  return body;
}

function InlineMessages({ id, errors = [], warnings = [] }: { id: string; errors?: string[]; warnings?: string[] }) {
  if (!errors.length && !warnings.length) return null;
  return <div id={id} className={errors.length ? "inline-messages error" : "inline-messages warning"} role={errors.length ? "alert" : "status"} tabIndex={-1}>
    <strong>{errors.length ? "Please fix this step" : "Imported with a note"}</strong>
    <ul>{[...errors, ...warnings].map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul>
  </div>;
}

function StepFrame({ step, children, onBack, onSkip }: { step: typeof steps[number]; children: ReactNode; onBack?: () => void; onSkip: () => void }) {
  return <section className="wizard-panel" aria-labelledby={`step-${step[0]}-title`}>
    <p className="kicker">Core setup · Step {steps.findIndex(([id]) => id === step[0]) + 1} of {steps.length}</p>
    <h2 id={`step-${step[0]}-title`}>{step[1]}</h2><p>{step[2]}</p>
    {children}
    <div className="wizard-secondary-actions">{onBack && <button type="button" onClick={onBack}>Back</button>}<button type="button" onClick={onSkip}>Skip for now</button></div>
  </section>;
}

export function SetupWorkspace({ initialBranding, onBrandingChanged, onSignedOut, embedded = false, onComplete }: { initialBranding: Branding; onBrandingChanged: (branding: Branding) => void; onSignedOut?: () => void; embedded?: boolean; onComplete?: () => void }) {
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [currentStep, setCurrentStep] = useState<StepId>("branding");
  const [branding, setBranding] = useState<Branding>(initialBranding);
  const [members, setMembers] = useState<Member[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [kioskName, setKioskName] = useState("Main kiosk");
  const [activeKiosk, setActiveKiosk] = useState<Kiosk>();
  const [replaceKiosk, setReplaceKiosk] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; workerApiUrl: string; purpose: "hardware" | "simulator" }>();
  const [pairingEntry, setPairingEntry] = useState("");
  const [simulator, setSimulator] = useState<Simulator | null>(null);
  const [kioskChoice, setKioskChoice] = useState<"hardware" | "simulator">("simulator");
  const [testMeetingId, setTestMeetingId] = useState("");
  const [simulatedMemberId, setSimulatedMemberId] = useState("");
  const [simulatedArrivalSent, setSimulatedArrivalSent] = useState(false);
  const [attendanceRows, setAttendanceRows] = useState<AttendanceRow[]>([]);
  const [messages, setMessages] = useState<Partial<Record<StepId, { errors?: string[]; warnings?: string[] }>>>({});
  const [notice, setNotice] = useState("Loading shared setup…");
  useDashboardLoadingOverlay(notice === "Loading shared setup…", "Loading guided setup…");
  const [showCelebration, setShowCelebration] = useState(false);
  const complete = completed.size === steps.length;
  const currentIndex = steps.findIndex(([id]) => id === currentStep);
  const progress = Math.round((completed.size / steps.length) * 100);
  const setupMeetings = meetings;

  useEffect(() => {
    Promise.all([
      api<{ settings: Branding }>("/admin/branding"), api<{ completedSteps: { step: StepId }[] }>("/admin/setup/progress"),
      api<{ members: Member[] }>("/admin/members"), api<{ kiosks: Kiosk[] }>("/admin/kiosks"), api<{ meetings: Meeting[] }>("/meetings"),
      api<{ simulator: Simulator | null }>("/admin/simulator"),
    ]).then(([brand, setup, roster, kioskStatus, meetingStatus, simulatorStatus]) => {
      const completedSet = new Set(setup.completedSteps.map((item) => item.step).filter((step) => setupStepIds.includes(step)));
      setBranding({ ...brand.settings, subtitle: brand.settings.subtitle ?? "", logoData: brand.settings.logoData ?? "", logoBackdrop: brand.settings.logoBackdrop ?? "auto", lateScanMinutes: brand.settings.lateScanMinutes ?? 30, discordContestWindowHours: brand.settings.discordContestWindowHours ?? 24 }); setCompleted(completedSet);
      setMembers(roster.members); setSimulatedMemberId(roster.members[0]?.memberId ?? ""); setActiveKiosk(kioskStatus.kiosks.find((kiosk) => kiosk.active === 1));
      setMeetings(meetingStatus.meetings); if (meetingStatus.meetings[0]) setTestMeetingId(meetingStatus.meetings[0].id);
      setSimulator(simulatorStatus.simulator); setCurrentStep(steps.find(([id]) => !completedSet.has(id))?.[0] ?? "branding"); setNotice("Setup progress is synchronized for every Admin.");
    }).catch((error: Error) => setNotice(error.message));
  }, []);

  function showMessages(step: StepId, value: { errors?: string[]; warnings?: string[] }) {
    setMessages((current) => ({ ...current, [step]: value }));
    if (value.errors?.length) window.requestAnimationFrame(() => document.getElementById(`messages-${step}`)?.focus());
  }
  async function markComplete(step: StepId) {
    if (!completed.has(step)) await api("/admin/setup/progress", { method: "PATCH", body: JSON.stringify({ step, completed: true }) });
    setCompleted((current) => new Set([...current, step]));
  }
  function goToIndex(index: number) { setCurrentStep(steps[Math.max(0, Math.min(index, steps.length - 1))][0]); window.scrollTo({ top: 0, behavior: "smooth" }); }
  async function finishStep(step: StepId, success: string) { await markComplete(step); showMessages(step, {}); setNotice(success); if (step === "confirm-attendance") setShowCelebration(true); else if (currentIndex < steps.length - 1) goToIndex(currentIndex + 1); }
  async function saveBranding(event: FormEvent) {
    event.preventDefault(); showMessages("branding", {});
    try { await api("/admin/branding", { method: "PATCH", body: JSON.stringify(branding) }); onBrandingChanged(branding); await finishStep("branding", "Organization and branding saved."); }
    catch (error) { showMessages("branding", { errors: [(error as Error).message] }); }
  }
  async function chooseLogo(file?: File) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 131_072) { showMessages("branding", { errors: ["Choose a PNG, JPEG, or WebP logo no larger than 128 KiB."] }); return; }
    const logoData = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Logo could not be read")); reader.readAsDataURL(file); });
    setBranding((current) => ({ ...current, logoData })); setNotice("Logo selected. Save this step to store it in D1.");
  }
  async function rosterImported() { const current = await api<{ members: Member[] }>("/admin/members"); setMembers(current.members); setSimulatedMemberId(current.members[0]?.memberId ?? ""); await markComplete("roster"); setNotice("Roster imported and ready for attendance."); goToIndex(currentIndex + 1); }
  async function createPairingCode(purpose: "hardware" | "simulator") {
    showMessages("pair-kiosk", {});
    try { const result = await api<{ code: string; expiresAt: string; workerApiUrl: string }>("/admin/pairing-codes", { method: "POST", body: JSON.stringify({ kioskName, replaceExisting: purpose === "hardware" ? replaceKiosk : false, purpose }) }); setPairing({ ...result, purpose }); setPairingEntry(result.code); setNotice("One-time code created. It expires in 10 minutes."); }
    catch (error) { showMessages("pair-kiosk", { errors: [(error as Error).message] }); }
  }
  async function pairSimulator() {
    showMessages("pair-kiosk", {});
    try { await api("/admin/simulator", { method: "POST", body: JSON.stringify({ action: "pair", code: pairingEntry, kioskName }) }); const status = await api<{ simulator: Simulator }>("/admin/simulator"); setSimulator(status.simulator); await finishStep("pair-kiosk", "Browser simulator paired. It has no hardware credential and does not count as an active kiosk."); }
    catch (error) { showMessages("pair-kiosk", { errors: [(error as Error).message] }); }
  }
  async function confirmHardwarePairing() {
    try { const result = await api<{ kiosks: Kiosk[] }>("/admin/kiosks"); const active = result.kiosks.find((kiosk) => kiosk.active === 1); setActiveKiosk(active); if (!active) throw new Error("No active hardware kiosk is visible yet. Complete the Pi installer, then try again."); await finishStep("pair-kiosk", `${active.name} is paired.`); }
    catch (error) { showMessages("pair-kiosk", { errors: [(error as Error).message] }); }
  }
  async function setSimulatorOnline(online: boolean) {
    try { await api("/admin/simulator", { method: "POST", body: JSON.stringify({ action: "heartbeat", online }) }); const status = await api<{ simulator: Simulator }>("/admin/simulator"); setSimulator(status.simulator); setNotice(`Simulator is ${online ? "online" : "offline"}.`); }
    catch (error) { showMessages("fingerprint-test", { errors: [(error as Error).message] }); }
  }
  async function simulatedScan(scanAction: "check_in" | "check_out") {
    showMessages("fingerprint-test", {});
    try { if (!testMeetingId || !simulatedMemberId) throw new Error("Choose a meeting and roster member first."); await api("/admin/simulator", { method: "POST", body: JSON.stringify({ action: "scan", scanAction, meetingId: testMeetingId, memberId: simulatedMemberId }) }); if (scanAction === "check_in") { setSimulatedArrivalSent(true); setNotice("Arrival scan delivered. Send the departure scan to complete attendance."); } else { setSimulatedArrivalSent(false); await finishStep("fingerprint-test", "Simulated arrival and departure scans delivered without fingerprint data."); } }
    catch (error) { showMessages("fingerprint-test", { errors: [(error as Error).message] }); }
  }
  async function refreshAttendance() {
    showMessages("confirm-attendance", {});
    try { if (!testMeetingId) throw new Error("Choose the meeting you want to verify."); const result = await api<{ attendance: AttendanceRow[] }>(`/attendance?meetingId=${encodeURIComponent(testMeetingId)}`); setAttendanceRows(result.attendance); if (!result.attendance.some((row) => row.disposition === "present")) throw new Error("No present check-in is visible yet. Return to the kiosk input step and submit one."); setNotice("Attendance is visible. Confirm it below when it matches what you expected."); }
    catch (error) { showMessages("confirm-attendance", { errors: [(error as Error).message] }); }
  }
  async function signOut() { await api("/auth/logout", { method: "POST" }); onSignedOut?.(); }

  const activeStep = steps[currentIndex];
  const stepBody: Record<StepId, ReactNode> = {
    branding: <form onSubmit={saveBranding}><InlineMessages id="messages-branding" {...messages.branding} /><label>Organization name<input required maxLength={100} value={branding.organizationName} onChange={(event) => setBranding({ ...branding, organizationName: event.target.value })} /></label><label>Subtitle <span>(optional)</span><input maxLength={140} value={branding.subtitle ?? ""} onChange={(event) => setBranding({ ...branding, subtitle: event.target.value })} /></label><label className="setup-logo-file">Logo image <span>(optional)</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseLogo(event.target.files?.[0])} /></label>{branding.logoData && <><div className="logo-preview"><AdaptiveBrandLogo src={branding.logoData} alt="Current organization logo preview" backdrop={branding.logoBackdrop} /><button type="button" onClick={() => setBranding({ ...branding, logoData: "" })}>Remove logo</button></div><fieldset className="logo-backdrop-options"><legend>Logo contrast background</legend><div>{([{ value: "auto", label: "Automatic" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "none", label: "None" }] as { value: LogoBackdrop; label: string }[]).map((option) => <label className={branding.logoBackdrop === option.value ? "selected" : ""} key={option.value}><input type="radio" name="setup-logo-backdrop" checked={branding.logoBackdrop === option.value} onChange={() => setBranding({ ...branding, logoBackdrop: option.value })} />{option.label}</label>)}</div></fieldset></>}<div className="color-grid"><ColorEditor label="Primary color" value={branding.primaryColor} onChange={(primaryColor) => setBranding({ ...branding, primaryColor })} /><ColorEditor label="Secondary color" value={branding.secondaryColor} onChange={(secondaryColor) => setBranding({ ...branding, secondaryColor })} /></div><button className="primary-button setup-branding-save" type="submit">Save and continue</button></form>,
    roster: <div><InlineMessages id="messages-roster" {...messages.roster} /><RosterImportPanel members={members} onImported={rosterImported} /><p className="record-count">{members.filter((member) => member.active).length} active roster record{members.filter((member) => member.active).length === 1 ? "" : "s"}</p></div>,
    "pair-kiosk": <div><InlineMessages id="messages-pair-kiosk" {...messages["pair-kiosk"]} /><fieldset><legend>What are you testing?</legend><div className="choice-grid"><label className={kioskChoice === "simulator" ? "choice selected" : "choice"}><input type="radio" checked={kioskChoice === "simulator"} onChange={() => setKioskChoice("simulator")} /><strong>Browser simulator</strong><span>No Pi or reader required. Test data stays isolated.</span></label><label className={kioskChoice === "hardware" ? "choice selected" : "choice"}><input type="radio" checked={kioskChoice === "hardware"} onChange={() => setKioskChoice("hardware")} /><strong>Raspberry Pi</strong><span>Install and pair the supported physical kiosk.</span></label></div></fieldset><label>Kiosk name<input maxLength={80} value={kioskName} onChange={(event) => setKioskName(event.target.value)} /></label>{kioskChoice === "simulator" ? <><p>The simulator consumes its own one-time code but never receives a production kiosk credential.</p><button className="primary-button" type="button" onClick={() => createPairingCode("simulator")}>Create simulator pairing code</button>{pairing?.purpose === "simulator" && <div className="pairing-code"><span>Simulator-only code</span><strong>{pairing.code}</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</small></div>}<label>Enter simulator pairing code<input value={pairingEntry} onChange={(event) => setPairingEntry(event.target.value.toUpperCase())} /></label><button className="primary-button" type="button" onClick={pairSimulator}>Pair browser simulator</button>{simulator?.active === 1 && <p className="success-note">Paired: {simulator.name}. Fingerprint reader intentionally unavailable.</p>}</> : <><p>Download the release installer on the Pi, preview it with <code>--dry-run</code>, then run it with <code>--install</code>. It starts the local pairing page without requesting cloud details.</p><a className="installer-link" href={kioskInstallerUrl}>Download guided Pi installer</a>{activeKiosk && <div className="replacement-notice"><strong>{activeKiosk.name} is active.</strong><label><input type="checkbox" checked={replaceKiosk} onChange={(event) => setReplaceKiosk(event.target.checked)} /> I understand redeeming a replacement key disables {activeKiosk.name}.</label></div>}<button className="primary-button" type="button" disabled={Boolean(activeKiosk) && !replaceKiosk} onClick={() => createPairingCode("hardware")}>{activeKiosk ? "Create replacement pairing key" : "Create one-time pairing key"}</button>{pairing?.purpose === "hardware" && <div className="pairing-key"><span>Paste from a phone or laptop on the Pi's local setup page</span><code>{hardwarePairingKey(pairing.workerApiUrl, pairing.code, kioskName)}</code><small>Contains this installation address, kiosk name, and a single-use code. Expires {new Date(pairing.expiresAt).toLocaleTimeString()}.</small><button type="button" onClick={() => void navigator.clipboard.writeText(hardwarePairingKey(pairing.workerApiUrl, pairing.code, kioskName)).then(() => setNotice("Pairing key copied. Open the Pi's local address and paste it there."), () => setNotice("Select and copy the displayed pairing key manually."))}>Copy one-time pairing key</button></div>}<button className="quiet-button" type="button" onClick={confirmHardwarePairing}>I paired the Pi — check status</button></>}</div>,
    "fingerprint-test": <div><InlineMessages id="messages-fingerprint-test" {...messages["fingerprint-test"]} />{simulator?.active === 1 ? <><div className="simulator-status"><strong>{simulator.name}</strong><span className={simulator.online ? "online" : "offline"}>{simulator.online ? "Online" : "Offline"}</span><small>Software-only · fingerprint reader unavailable · does not count as an active kiosk</small></div><div className="wizard-secondary-actions"><button type="button" onClick={() => setSimulatorOnline(true)}>Bring online</button><button type="button" onClick={() => setSimulatorOnline(false)}>Go offline</button></div><label>Meeting<select value={testMeetingId} onChange={(event) => { setTestMeetingId(event.target.value); setSimulatedArrivalSent(false); }}><option value="">Choose a meeting</option>{setupMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title}</option>)}</select></label><label>Roster member<select value={simulatedMemberId} onChange={(event) => { setSimulatedMemberId(event.target.value); setSimulatedArrivalSent(false); }}><option value="">Choose a member</option>{members.map((member) => <option key={member.memberId} value={member.memberId}>{member.firstName} {member.lastName} · {member.memberId}</option>)}</select></label><button className="primary-button" type="button" onClick={() => simulatedScan(simulatedArrivalSent ? "check_out" : "check_in")}>{simulatedArrivalSent ? "Send simulated departure scan" : "Send simulated arrival scan"}</button></> : <><p>On the Pi, open <code>http://127.0.0.1:8788/</code> and run the reader test. Templates and scans remain exclusively inside the R503.</p><button className="primary-button" type="button" onClick={() => finishStep("fingerprint-test", "Hardware reader test recorded as complete.")}>The local reader test passed</button></>}</div>,
    "confirm-attendance": <div><InlineMessages id="messages-confirm-attendance" {...messages["confirm-attendance"]} /><label>Meeting<select value={testMeetingId} onChange={(event) => setTestMeetingId(event.target.value)}><option value="">Choose a meeting</option>{setupMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title}</option>)}</select></label><button className="primary-button" type="button" onClick={refreshAttendance}>Refresh attendance</button>{attendanceRows.length > 0 && <ul className="confirmation-list">{attendanceRows.map((row) => <li key={row.memberId}><span>{row.firstName} {row.lastName}</span><strong className={`attendance-state ${row.disposition}`}>{row.disposition}</strong></li>)}</ul>}<button className="primary-button" type="button" disabled={!attendanceRows.some((row) => row.disposition === "present")} onClick={() => finishStep("confirm-attendance", "Guided setup complete.")}>Attendance matches — finish setup</button></div>,
  };

  return <div className="workspace-shell">
    {!embedded && <header className="workspace-header"><div><p className="kicker">{branding.organizationName}</p><h1>{complete ? "Setup complete" : activeStep[1]}</h1></div><button className="theme-button" type="button" onClick={signOut}>Sign out</button></header>}
    <div className="setup-progress" role="progressbar" aria-label="Guided setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><div className="setup-progress-fill" style={{ width: `${progress}%` }} /><span>{progress}%</span></div>
    <p className="visually-hidden" role="status">{notice}</p>
    <div className="wizard-layout">
      <nav className="wizard-steps" aria-label="Core setup steps"><p className="kicker">Resumable onboarding</p><ol>{steps.map(([id, title], index) => <li key={id}><button type="button" className={id === currentStep ? "active" : ""} aria-current={id === currentStep ? "step" : undefined} onClick={() => { setCurrentStep(id); window.scrollTo({ top: 0, behavior: "auto" }); }}><span>{completed.has(id) ? "✓" : index + 1}</span>{title}</button></li>)}</ol>{complete && <button className="primary-button setup-finish-button" type="button" onClick={onComplete}>Finish and return to dashboard</button>}</nav>
      <StepFrame step={activeStep} onBack={currentIndex > 0 ? () => goToIndex(currentIndex - 1) : undefined} onSkip={() => goToIndex(currentIndex + 1)}>{stepBody[currentStep]}</StepFrame>
    </div>
    {showCelebration && <div className="completion-overlay"><div className="confetti" aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ "--piece": index, "--left": `${(index * 37) % 100}%`, "--drift": `${(index % 5 - 2) * 2}rem` } as React.CSSProperties} />)}</div><section className="completion-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-complete-title"><span className="completion-icon" aria-hidden="true">✓</span><h2 id="setup-complete-title">Setup complete</h2><p>Your roster, kiosk path, and attendance confirmation are ready. You can revisit Setup at any time.</p><button className="primary-button" type="button" autoFocus onClick={() => { setShowCelebration(false); onComplete?.(); }}>Go to Dashboard</button></section></div>}
  </div>;
}
