import { FormEvent, useEffect, useMemo, useState } from "react";
import { AttendanceWorkspace } from "./attendance-workspace";
import { IntegrationSettings } from "./integration-settings";
import { UserSettings } from "./user-settings";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string).replace(/\/$/, "");
const steps = [
  ["branding", "Brand your installation", "Set the organization name, optional subtitle/logo, colors, and appearance."],
  ["roster", "Import your roster", "Add the people who can attend. You can update matching member IDs later."],
  ["pair-kiosk", "Pair the kiosk", "Create a 10-minute, one-time code for the guided Raspberry Pi installer."],
  ["fingerprint-test", "Test the fingerprint reader", "Confirm the R503 responds locally. Templates never leave the sensor."],
  ["test-meeting", "Run a test meeting", "Create a short meeting and check in with the kiosk."],
  ["confirm-attendance", "Confirm attendance", "Verify the dashboard received the expected test attendance."],
] as const;
type StepId = typeof steps[number][0];
type Branding = { organizationName: string; subtitle?: string; logoUrl?: string; primaryColor: string; secondaryColor: string; appearance: "system" | "light" | "dark" };
type Member = { memberId: string; firstName: string; lastName: string; email?: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await result.json() as T & { error?: string; details?: string[] };
  if (!result.ok) throw new Error(body.details?.join(" ") ?? body.error ?? "Request failed");
  return body;
}

export function SetupWorkspace({ organizationName, onSignedOut }: { organizationName: string; onSignedOut: () => void }) {
  const [completed, setCompleted] = useState<Set<StepId>>(new Set());
  const [branding, setBranding] = useState<Branding>({ organizationName, subtitle: "", logoUrl: "", primaryColor: "#7c3aed", secondaryColor: "#0f766e", appearance: "system" });
  const [members, setMembers] = useState<Member[]>([]);
  const [rosterText, setRosterText] = useState("memberId,firstName,lastName,email,discordUserId\n");
  const [kioskName, setKioskName] = useState("Main kiosk");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string }>();
  const [notice, setNotice] = useState("Loading shared setup…");
  const [showChecklist, setShowChecklist] = useState(true);
  const complete = completed.size === steps.length;
  const progress = Math.round((completed.size / steps.length) * 100);

  useEffect(() => {
    Promise.all([
      api<{ settings: Branding }>("/admin/branding"),
      api<{ completedSteps: { step: StepId }[] }>("/admin/setup/progress"),
      api<{ members: Member[] }>("/admin/members"),
    ]).then(([brand, setup, roster]) => {
      setBranding({ ...brand.settings, subtitle: brand.settings.subtitle ?? "", logoUrl: brand.settings.logoUrl ?? "" });
      setCompleted(new Set(setup.completedSteps.map((item) => item.step)));
      setMembers(roster.members);
      setNotice("Setup is synchronized for every Admin.");
    }).catch((error: Error) => setNotice(error.message));
  }, []);

  async function toggle(step: StepId) {
    const value = !completed.has(step);
    await api("/admin/setup/progress", { method: "PATCH", body: JSON.stringify({ step, completed: value }) });
    setCompleted((current) => { const next = new Set(current); value ? next.add(step) : next.delete(step); return next; });
  }
  async function saveBranding(event: FormEvent) {
    event.preventDefault(); setNotice("Saving branding…");
    try { await api("/admin/branding", { method: "PATCH", body: JSON.stringify(branding) }); if (!completed.has("branding")) await toggle("branding"); setNotice("Branding saved."); } catch (error) { setNotice((error as Error).message); }
  }
  async function importRoster(event: FormEvent) {
    event.preventDefault(); setNotice("Importing roster…");
    try {
      const lines = rosterText.trim().split(/\r?\n/); const headers = lines.shift()?.split(",").map((value) => value.trim()) ?? [];
      const required = ["memberId", "firstName", "lastName"]; if (required.some((header) => !headers.includes(header))) throw new Error("CSV needs memberId, firstName, and lastName columns.");
      const incoming = lines.filter(Boolean).map((line) => { const values = line.split(",").map((value) => value.trim()); return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])) as Member; });
      const result = await api<{ imported: number }>("/admin/members", { method: "POST", body: JSON.stringify({ members: incoming }) });
      const current = await api<{ members: Member[] }>("/admin/members"); setMembers(current.members); if (!completed.has("roster")) await toggle("roster"); setNotice(`${result.imported} roster member${result.imported === 1 ? "" : "s"} imported.`);
    } catch (error) { setNotice((error as Error).message); }
  }
  async function createPairingCode() {
    setNotice("Creating one-time pairing code…");
    try { const result = await api<{ code: string; expiresAt: string }>("/admin/pairing-codes", { method: "POST", body: JSON.stringify({ kioskName }) }); setPairing(result); setNotice("Pairing code created. Enter it only in the local kiosk installer."); } catch (error) { setNotice((error as Error).message); }
  }
  async function signOut() { await api("/auth/logout", { method: "POST" }); onSignedOut(); }

  const nextStep = useMemo(() => steps.find(([id]) => !completed.has(id)), [completed]);
  return <div className="workspace-shell">
    <header className="workspace-header"><div><p className="kicker">{branding.organizationName}</p><h1>{complete ? "Setup complete" : nextStep ? nextStep[1] : "Setup"}</h1></div><button className="theme-button" type="button" onClick={signOut}>Sign out</button></header>
    <div className="setup-status" role="status"><span>{notice}</span><strong>{progress}% complete</strong></div>
    {complete && !showChecklist ? <section className="completion-card"><span aria-hidden="true">✓</span><div><h2>Your kiosk-ready foundation is complete</h2><p>The checklist remains available from Setup whenever you need to revisit a step.</p></div><button type="button" onClick={() => setShowChecklist(true)}>Open Setup</button></section> : <>
      <section className="checklist-card" aria-labelledby="checklist-title"><div><p className="kicker">Resumable onboarding</p><h2 id="checklist-title">Setup checklist</h2><p>Progress is shared across Admin accounts. Optional integrations never block completion.</p></div><ol>{steps.map(([id, title, detail], index) => <li key={id} className={completed.has(id) ? "done" : ""}><button type="button" onClick={() => toggle(id)} aria-label={`${completed.has(id) ? "Reopen" : "Complete"} ${title}`}>{completed.has(id) ? "✓" : index + 1}</button><div><strong>{title}</strong><span>{detail}</span></div></li>)}</ol>{complete && <button className="quiet-button" type="button" onClick={() => setShowChecklist(false)}>Hide completed checklist</button>}</section>
      <div className="workspace-grid">
        <form className="task-card" onSubmit={saveBranding}><p className="kicker">Branding</p><h2>Make it yours</h2><label>Organization name<input required maxLength={100} value={branding.organizationName} onChange={(event) => setBranding({ ...branding, organizationName: event.target.value })} /></label><label>Subtitle <span>(optional)</span><input maxLength={140} value={branding.subtitle ?? ""} onChange={(event) => setBranding({ ...branding, subtitle: event.target.value })} /></label><label>Logo HTTPS URL <span>(optional)</span><input type="url" value={branding.logoUrl ?? ""} onChange={(event) => setBranding({ ...branding, logoUrl: event.target.value })} /></label><div className="color-grid"><label>Primary<input type="color" value={branding.primaryColor} onChange={(event) => setBranding({ ...branding, primaryColor: event.target.value })} /></label><label>Secondary<input type="color" value={branding.secondaryColor} onChange={(event) => setBranding({ ...branding, secondaryColor: event.target.value })} /></label></div><label>Appearance<select value={branding.appearance} onChange={(event) => setBranding({ ...branding, appearance: event.target.value as Branding["appearance"] })}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label><button className="primary-button" type="submit">Save branding</button></form>
        <form className="task-card" onSubmit={importRoster}><p className="kicker">Roster</p><h2>Import members</h2><p>Paste CSV with the required headers. Matching member IDs are safely updated. Add an optional Discord user ID to link a member for pings and contests.</p><label>Roster CSV<textarea rows={9} value={rosterText} onChange={(event) => setRosterText(event.target.value)} /></label><button className="primary-button" type="submit">Validate and import</button><p className="record-count">{members.length} active roster record{members.length === 1 ? "" : "s"}</p></form>
        <section className="task-card pairing-card"><p className="kicker">Kiosk pairing</p><h2>Create a one-time code</h2><p>The code expires in 10 minutes and can be redeemed once. It never contains a fingerprint template or Cloudflare credential.</p><label>Kiosk name<input maxLength={80} value={kioskName} onChange={(event) => setKioskName(event.target.value)} /></label><button className="primary-button" type="button" onClick={createPairingCode}>Create pairing code</button>{pairing && <div className="pairing-code" aria-live="polite"><span>Enter in the Pi installer</span><strong>{pairing.code}</strong><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</small></div>}</section>
      </div>
    </>}
    <AttendanceWorkspace embedded />
    <IntegrationSettings />
    <UserSettings />
  </div>;
}
