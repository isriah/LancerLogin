import { FormEvent, ReactNode, useEffect, useState } from "react";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const installerUrl = "https://github.com/isriah/LancerLogin/releases/latest/download/install-lancerlogin.sh";
const steps = [
  ["branding", "Organization & brand", "Choose the name and appearance people will see."],
  ["test-meeting", "Initial test meeting", "Create a safe test meeting before adding attendance."],
  ["roster", "Roster", "Import the people who can attend. Discord is not required."],
  ["pair-kiosk", "Kiosk", "Pair hardware or the browser simulator with a one-time code."],
  ["fingerprint-test", "Kiosk input test", "Test the reader on hardware or a member selection in the simulator."],
  ["confirm-attendance", "Attendance confirmation", "Confirm the expected test check-in reached the dashboard."],
] as const;
type StepId = typeof steps[number][0];
export type Branding = { organizationName: string; subtitle?: string; logoData?: string; primaryColor: string; secondaryColor: string; appearance: "system" | "themed" | "light" | "dark" };
type Member = { memberId: string; firstName: string; lastName: string; email?: string; discordUserId?: string };
type Kiosk = { id: string; name: string; active: number; lastSeenAt?: string; pairedAt: string };
type Meeting = { id: string; title: string; startsAt: string; isTest?: boolean | number };
type Simulator = { name: string; active: number; online: number; lastSeenAt?: string; pairedAt: string; readerOnline: false; releaseVersion: string };
type AttendanceRow = { memberId: string; externalId: string; firstName: string; lastName: string; disposition: "present" | "absent" | "excused" };

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
  const [rosterText, setRosterText] = useState("memberId,firstName,lastName,email\n");
  const [kioskName, setKioskName] = useState("Main kiosk");
  const [activeKiosk, setActiveKiosk] = useState<Kiosk>();
  const [replaceKiosk, setReplaceKiosk] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; purpose: "hardware" | "simulator" }>();
  const [pairingEntry, setPairingEntry] = useState("");
  const [simulator, setSimulator] = useState<Simulator | null>(null);
  const [kioskChoice, setKioskChoice] = useState<"hardware" | "simulator">("simulator");
  const [testMeetingTitle, setTestMeetingTitle] = useState("LancerLogin setup test");
  const [testMeetingStarts, setTestMeetingStarts] = useState(new Date(Date.now() + 15 * 60_000).toISOString().slice(0, 16));
  const [testMeetingId, setTestMeetingId] = useState("");
  const [simulatedMemberId, setSimulatedMemberId] = useState("");
  const [attendanceRows, setAttendanceRows] = useState<AttendanceRow[]>([]);
  const [messages, setMessages] = useState<Partial<Record<StepId, { errors?: string[]; warnings?: string[] }>>>({});
  const [notice, setNotice] = useState("Loading shared setup…");
  const [showChecklist, setShowChecklist] = useState(true);
  const [showCelebration, setShowCelebration] = useState(false);
  const complete = completed.size === steps.length;
  const currentIndex = steps.findIndex(([id]) => id === currentStep);
  const progress = Math.round((completed.size / steps.length) * 100);
  const testMeetings = meetings.filter((meeting) => Boolean(meeting.isTest));

  useEffect(() => {
    Promise.all([
      api<{ settings: Branding }>("/admin/branding"), api<{ completedSteps: { step: StepId }[] }>("/admin/setup/progress"),
      api<{ members: Member[] }>("/admin/members"), api<{ kiosks: Kiosk[] }>("/admin/kiosks"), api<{ meetings: Meeting[] }>("/meetings"),
      api<{ simulator: Simulator | null }>("/admin/simulator"),
    ]).then(([brand, setup, roster, kioskStatus, meetingStatus, simulatorStatus]) => {
      const completedSet = new Set(setup.completedSteps.map((item) => item.step));
      setBranding({ ...brand.settings, subtitle: brand.settings.subtitle ?? "", logoData: brand.settings.logoData ?? "" }); setCompleted(completedSet);
      setShowChecklist(completedSet.size < steps.length); setMembers(roster.members); setSimulatedMemberId(roster.members[0]?.memberId ?? ""); setActiveKiosk(kioskStatus.kiosks.find((kiosk) => kiosk.active === 1));
      setMeetings(meetingStatus.meetings); const existingTest = meetingStatus.meetings.find((meeting) => Boolean(meeting.isTest)); if (existingTest) setTestMeetingId(existingTest.id);
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
  async function createTestMeeting(event: FormEvent) {
    event.preventDefault(); showMessages("test-meeting", {});
    try {
      const result = await api<{ meeting: Meeting }>("/meetings", { method: "POST", body: JSON.stringify({ title: testMeetingTitle, startsAt: new Date(testMeetingStarts).toISOString(), required: true, isTest: true, notes: "Created by guided setup; simulated attendance is allowed only in test meetings." }) });
      setMeetings((current) => [result.meeting, ...current]); setTestMeetingId(result.meeting.id); await finishStep("test-meeting", "Test meeting created. It is clearly marked as test data.");
    } catch (error) { showMessages("test-meeting", { errors: [(error as Error).message] }); }
  }
  async function importRoster(event: FormEvent) {
    event.preventDefault(); showMessages("roster", {});
    try {
      const lines = rosterText.trim().split(/\r?\n/); const headers = lines.shift()?.split(",").map((value) => value.trim()) ?? [];
      const required = ["memberId", "firstName", "lastName"]; const errors: string[] = []; const warnings: string[] = [];
      if (required.some((header) => !headers.includes(header))) errors.push("The header row needs memberId, firstName, and lastName. Email and discordUserId are optional.");
      const seen = new Set<string>();
      const incoming = lines.filter((line) => line.trim()).map((line, index) => { const values = line.split(",").map((value) => value.trim()); return { row: index + 2, value: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])) as Member }; });
      for (const { row, value } of incoming) { if (!value.memberId || !value.firstName || !value.lastName) errors.push(`Row ${row}: memberId, firstName, and lastName are required.`); if (seen.has(value.memberId)) errors.push(`Row ${row}: memberId ${value.memberId} is duplicated.`); seen.add(value.memberId); if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) errors.push(`Row ${row}: enter a valid email address or leave it blank.`); if (value.discordUserId && !/^\d{10,24}$/.test(value.discordUserId)) warnings.push(`Row ${row}: the optional Discord ID will be ignored. You can link Discord later.`); }
      if (!incoming.length) errors.push("Add at least one roster row below the header.");
      if (errors.length) { showMessages("roster", { errors, warnings }); return; }
      const result = await api<{ imported: number; warnings?: string[] }>("/admin/members", { method: "POST", body: JSON.stringify({ members: incoming.map(({ value }) => value) }) });
      const current = await api<{ members: Member[] }>("/admin/members"); setMembers(current.members); setSimulatedMemberId(current.members[0]?.memberId ?? "");
      await markComplete("roster"); showMessages("roster", { warnings: result.warnings ?? warnings }); setNotice(`${result.imported} roster member${result.imported === 1 ? "" : "s"} imported.`); goToIndex(currentIndex + 1);
    } catch (error) { showMessages("roster", { errors: [(error as Error).message] }); }
  }
  async function createPairingCode(purpose: "hardware" | "simulator") {
    showMessages("pair-kiosk", {});
    try { const result = await api<{ code: string; expiresAt: string }>("/admin/pairing-codes", { method: "POST", body: JSON.stringify({ kioskName, replaceExisting: purpose === "hardware" ? replaceKiosk : false, purpose }) }); setPairing({ ...result, purpose }); setPairingEntry(result.code); setNotice("One-time code created. It expires in 10 minutes."); }
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
  async function simulatedCheckIn() {
    showMessages("fingerprint-test", {});
    try { if (!testMeetingId || !simulatedMemberId) throw new Error("Choose a test meeting and roster member first."); await api("/admin/simulator", { method: "POST", body: JSON.stringify({ action: "check-in", meetingId: testMeetingId, memberId: simulatedMemberId }) }); await finishStep("fingerprint-test", "Simulated check-in delivered without fingerprint data."); }
    catch (error) { showMessages("fingerprint-test", { errors: [(error as Error).message] }); }
  }
  async function refreshAttendance() {
    showMessages("confirm-attendance", {});
    try { if (!testMeetingId) throw new Error("Choose the test meeting you want to verify."); const result = await api<{ attendance: AttendanceRow[] }>(`/attendance?meetingId=${encodeURIComponent(testMeetingId)}`); setAttendanceRows(result.attendance); if (!result.attendance.some((row) => row.disposition === "present")) throw new Error("No present check-in is visible yet. Return to the kiosk input step and submit one."); setNotice("Test attendance is visible. Confirm it below when it matches what you expected."); }
    catch (error) { showMessages("confirm-attendance", { errors: [(error as Error).message] }); }
  }
  async function signOut() { await api("/auth/logout", { method: "POST" }); onSignedOut?.(); }

  const activeStep = steps[currentIndex];
  const stepBody: Record<StepId, ReactNode> = {
    branding: <form onSubmit={saveBranding}><InlineMessages id="messages-branding" {...messages.branding} /><label>Organization name<input required maxLength={100} value={branding.organizationName} onChange={(event) => setBranding({ ...branding, organizationName: event.target.value })} /></label><label>Subtitle <span>(optional)</span><input maxLength={140} value={branding.subtitle ?? ""} onChange={(event) => setBranding({ ...branding, subtitle: event.target.value })} /></label><label>Logo image <span>(optional, stored in D1)</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseLogo(event.target.files?.[0])} /></label>{branding.logoData && <div className="logo-preview"><img src={branding.logoData} alt="Current organization logo preview" /><button type="button" onClick={() => setBranding({ ...branding, logoData: "" })}>Remove logo</button></div>}<div className="color-grid"><label>Primary<input type="color" value={branding.primaryColor} onChange={(event) => setBranding({ ...branding, primaryColor: event.target.value })} /></label><label>Secondary<input type="color" value={branding.secondaryColor} onChange={(event) => setBranding({ ...branding, secondaryColor: event.target.value })} /></label></div><label>Appearance<select value={branding.appearance} onChange={(event) => setBranding({ ...branding, appearance: event.target.value as Branding["appearance"] })}><option value="themed">Organization colors</option><option value="light">Light</option><option value="dark">Dark</option><option value="system">Follow device</option></select></label><button className="primary-button" type="submit">Save and continue</button></form>,
    "test-meeting": <form onSubmit={createTestMeeting}><InlineMessages id="messages-test-meeting" {...messages["test-meeting"]} />{testMeetings.length > 0 && <label>Existing test meeting<select value={testMeetingId} onChange={(event) => setTestMeetingId(event.target.value)}><option value="">Create another test meeting</option>{testMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title} · {new Date(meeting.startsAt).toLocaleString()}</option>)}</select></label>}<label>Meeting title<input required maxLength={120} value={testMeetingTitle} onChange={(event) => setTestMeetingTitle(event.target.value)} /></label><label>Starts<input required type="datetime-local" value={testMeetingStarts} onChange={(event) => setTestMeetingStarts(event.target.value)} /></label><p className="field-help">This meeting is marked as test data. The browser simulator cannot check in to normal meetings.</p>{testMeetingId && <button className="quiet-button" type="button" onClick={() => void finishStep("test-meeting", "Existing test meeting selected.")}>Use selected test meeting</button>}<button className="primary-button" type="submit">Create test meeting and continue</button></form>,
    roster: <form onSubmit={importRoster}><InlineMessages id="messages-roster" {...messages.roster} /><p>Paste CSV with the required headers. Discord is optional, is configured later, and never blocks core roster import.</p><label>Roster CSV<textarea rows={10} aria-describedby="roster-help" value={rosterText} onChange={(event) => setRosterText(event.target.value)} /></label><p id="roster-help" className="field-help">Required: memberId, firstName, lastName. Optional: email. You may also include discordUserId, but an invalid value is ignored rather than blocking import.</p><button className="primary-button" type="submit">Validate and import</button><p className="record-count">{members.length} active roster record{members.length === 1 ? "" : "s"}</p></form>,
    "pair-kiosk": <div><InlineMessages id="messages-pair-kiosk" {...messages["pair-kiosk"]} /><fieldset><legend>What are you testing?</legend><div className="choice-grid"><label className={kioskChoice === "simulator" ? "choice selected" : "choice"}><input type="radio" checked={kioskChoice === "simulator"} onChange={() => setKioskChoice("simulator")} /><strong>Browser simulator</strong><span>No Pi or reader required. Test data stays isolated.</span></label><label className={kioskChoice === "hardware" ? "choice selected" : "choice"}><input type="radio" checked={kioskChoice === "hardware"} onChange={() => setKioskChoice("hardware")} /><strong>Raspberry Pi</strong><span>Install and pair the supported physical kiosk.</span></label></div></fieldset><label>Kiosk name<input maxLength={80} value={kioskName} onChange={(event) => setKioskName(event.target.value)} /></label>{kioskChoice === "simulator" ? <><p>The simulator consumes its own one-time code but never receives a production kiosk bearer credential.</p><button className="primary-button" type="button" onClick={() => createPairingCode("simulator")}>Create simulator pairing code</button>{pairing?.purpose === "simulator" && <div className="pairing-code"><span>Simulator-only code</span><strong>{pairing.code}</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</small></div>}<label>Enter simulator pairing code<input value={pairingEntry} onChange={(event) => setPairingEntry(event.target.value.toUpperCase())} /></label><button className="primary-button" type="button" onClick={pairSimulator}>Pair browser simulator</button>{simulator?.active === 1 && <p className="success-note">Paired: {simulator.name}. Fingerprint reader intentionally unavailable.</p>}</> : <><p>Download the release installer on the Pi, preview it with <code>--dry-run</code>, then run it with <code>--install</code>.</p><a className="installer-link" href={installerUrl}>Download guided Pi installer</a>{activeKiosk && <div className="replacement-notice"><strong>{activeKiosk.name} is active.</strong><label><input type="checkbox" checked={replaceKiosk} onChange={(event) => setReplaceKiosk(event.target.checked)} /> I understand redeeming a replacement code disables {activeKiosk.name}.</label></div>}<button className="primary-button" type="button" disabled={Boolean(activeKiosk) && !replaceKiosk} onClick={() => createPairingCode("hardware")}>{activeKiosk ? "Create replacement code" : "Create hardware pairing code"}</button>{pairing?.purpose === "hardware" && <div className="pairing-code"><span>Enter in the Pi installer</span><strong>{pairing.code}</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</small></div>}<button className="quiet-button" type="button" onClick={confirmHardwarePairing}>I finished the Pi installer — check pairing</button></>}</div>,
    "fingerprint-test": <div><InlineMessages id="messages-fingerprint-test" {...messages["fingerprint-test"]} />{simulator?.active === 1 ? <><div className="simulator-status"><strong>{simulator.name}</strong><span className={simulator.online ? "online" : "offline"}>{simulator.online ? "Online" : "Offline"}</span><small>Software-only · fingerprint reader unavailable · does not count as an active kiosk</small></div><div className="wizard-secondary-actions"><button type="button" onClick={() => setSimulatorOnline(true)}>Bring online</button><button type="button" onClick={() => setSimulatorOnline(false)}>Go offline</button></div><label>Test meeting<select value={testMeetingId} onChange={(event) => setTestMeetingId(event.target.value)}><option value="">Choose a test meeting</option>{testMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title}</option>)}</select></label><label>Roster member<select value={simulatedMemberId} onChange={(event) => setSimulatedMemberId(event.target.value)}><option value="">Choose a member</option>{members.map((member) => <option key={member.memberId} value={member.memberId}>{member.firstName} {member.lastName} · {member.memberId}</option>)}</select></label><button className="primary-button" type="button" onClick={simulatedCheckIn}>Send simulated check-in</button></> : <><p>On the Pi, open <code>http://127.0.0.1:8788/</code> and run the reader test. Templates and scans remain exclusively inside the R503.</p><button className="primary-button" type="button" onClick={() => finishStep("fingerprint-test", "Hardware reader test recorded as complete.")}>The local reader test passed</button></>}</div>,
    "confirm-attendance": <div><InlineMessages id="messages-confirm-attendance" {...messages["confirm-attendance"]} /><label>Test meeting<select value={testMeetingId} onChange={(event) => setTestMeetingId(event.target.value)}><option value="">Choose a test meeting</option>{testMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title}</option>)}</select></label><button className="primary-button" type="button" onClick={refreshAttendance}>Refresh test attendance</button>{attendanceRows.length > 0 && <ul className="confirmation-list">{attendanceRows.map((row) => <li key={row.memberId}><span>{row.firstName} {row.lastName}</span><strong className={`attendance-state ${row.disposition}`}>{row.disposition}</strong></li>)}</ul>}<button className="primary-button" type="button" disabled={!attendanceRows.some((row) => row.disposition === "present")} onClick={() => finishStep("confirm-attendance", "Guided setup complete.")}>Attendance matches — finish setup</button></div>,
  };

  return <div className="workspace-shell">
    {!embedded && <header className="workspace-header"><div><p className="kicker">{branding.organizationName}</p><h1>{complete ? "Setup complete" : activeStep[1]}</h1></div><button className="theme-button" type="button" onClick={signOut}>Sign out</button></header>}
    <div className="setup-status" role="status"><span>{notice}</span><strong>{progress}% complete</strong></div>
    {complete && !showChecklist ? <section className="completion-card"><span aria-hidden="true">✓</span><div><h2>Your kiosk-ready foundation is complete</h2><p>Setup remains available whenever you need to revisit branding, roster, pairing, or testing.</p></div><button type="button" onClick={() => setShowChecklist(true)}>Open Setup</button></section> : <div className="wizard-layout">
      <nav className="wizard-steps" aria-label="Core setup steps"><p className="kicker">Resumable onboarding</p><ol>{steps.map(([id, title], index) => <li key={id}><button type="button" className={id === currentStep ? "active" : ""} aria-current={id === currentStep ? "step" : undefined} onClick={() => setCurrentStep(id)}><span>{completed.has(id) ? "✓" : index + 1}</span>{title}</button></li>)}</ol>{complete && <button className="quiet-button" type="button" onClick={() => setShowChecklist(false)}>Hide completed setup</button>}</nav>
      <StepFrame step={activeStep} onBack={currentIndex > 0 ? () => goToIndex(currentIndex - 1) : undefined} onSkip={() => goToIndex(currentIndex + 1)}>{stepBody[currentStep]}</StepFrame>
    </div>}
    {showCelebration && <div className="completion-overlay"><div className="confetti" aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ "--piece": index, "--left": `${(index * 37) % 100}%`, "--drift": `${(index % 5 - 2) * 2}rem` } as React.CSSProperties} />)}</div><section className="completion-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-complete-title"><span className="completion-icon" aria-hidden="true">✓</span><h2 id="setup-complete-title">Setup complete</h2><p>Your roster, test meeting, kiosk path, and attendance confirmation are ready. You can revisit Setup at any time.</p><button className="primary-button" type="button" autoFocus onClick={() => { setShowCelebration(false); onComplete?.(); }}>Go to dashboard home</button></section></div>}
  </div>;
}
