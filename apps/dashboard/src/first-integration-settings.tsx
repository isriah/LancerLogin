import { FormEvent, useEffect, useState } from "react";
import { api } from "./dashboard-api";
import "./first-integration-settings.css";

// Settings > Integrations > FIRST: Core's one FIRST connection, which modules use through services.first. An Admin saves
// an FRC and an FTC Events API username and token (checked with FIRST, then stored encrypted and never shown again), sees
// whether FLL's public team search is available, and can test a team number or clear FIRST's cached answers.

type EventsProgram = "FRC" | "FTC";
type Program = EventsProgram | "Challenge" | "Explore";
type CredentialStatus = { saved: boolean; username: string; checkedAt: string | null; readable: boolean };
type FirstStatus = { programs: Record<EventsProgram, CredentialStatus>; fll: { available: boolean }; encryption: boolean };
type Lookup = { status: "found"; team: { program: Program; number: string; name: string; location: string; season: number } } | { status: "not-found" } | { status: "unavailable"; reason: "not-configured" | "rate-limited" | "timeout" | "provider-error" };
type Notice = { tone: "success" | "error" | "warning" | "neutral"; text: string };

const eventsPrograms: readonly EventsProgram[] = ["FRC", "FTC"];
const programLabels: Record<Program, string> = { FRC: "FRC", FTC: "FTC", Challenge: "FLL Challenge", Explore: "FLL Explore" };
/** FIRST's Events API registration pages, where an Admin requests a username and token. */
export const firstApiRegistration: Readonly<Record<EventsProgram, string>> = {
  FRC: "https://frc-events.firstinspires.org/services/API",
  FTC: "https://ftc-events.firstinspires.org/services/API",
};
// Browsers and password managers treat a text input followed by a password input as a sign-in form, so these opt out.
const passwordManagerIgnore = { "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" } as const;

const checkedDate = (value: string | null) => { const date = value ? new Date(value) : undefined; return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { dateStyle: "medium" }) : ""; };
function credentialPill(status: CredentialStatus): Notice {
  if (!status.saved) return { tone: "neutral", text: "Not set" };
  if (!status.readable) return { tone: "warning", text: "Saved, but can't be read" };
  return { tone: "success", text: checkedDate(status.checkedAt) ? `Checked ${checkedDate(status.checkedAt)}` : "Checked" };
}
function cardPill(status?: FirstStatus): Notice | undefined {
  if (!status) return undefined;
  const connected = eventsPrograms.filter((program) => status.programs[program].saved && status.programs[program].readable);
  if (connected.length) return { tone: "success", text: `Connected for ${connected.join(" and ")}` };
  return eventsPrograms.some((program) => status.programs[program].saved) ? { tone: "warning", text: "Needs attention" } : { tone: "neutral", text: "Not connected" };
}
/** One plain line for a test lookup's answer. */
export function lookupText(program: Program, number: string, result: Lookup, fllAvailable: boolean): Notice {
  const label = programLabels[program];
  if (result.status === "found") return { tone: "success", text: `${label} ${number}: ${result.team.name}${result.team.location ? `, ${result.team.location}` : ""} (${result.team.season} season)` };
  if (result.status === "not-found") return { tone: "neutral", text: `No ${label} team ${number} found.` };
  const fll = program === "Challenge" || program === "Explore";
  if (result.reason === "not-configured") return { tone: "warning", text: `${label} lookups are off. Save an ${label} username and token above.` };
  if (result.reason === "rate-limited") return { tone: "warning", text: "Too many lookups in the last minute. Try again in a minute." };
  if (result.reason === "timeout") return { tone: "error", text: "FIRST did not answer in time. Try again." };
  return fll && !fllAvailable ? { tone: "neutral", text: "FLL lookups are not available yet." } : { tone: "error", text: `FIRST's answer for ${label} ${number} could not be read. Try again later.` };
}

function ProgramCredential({ program, status, onChanged, onDirty }: { program: EventsProgram; status: CredentialStatus; onChanged: (next: FirstStatus) => void; onDirty: (dirty: boolean) => void }) {
  const [username, setUsername] = useState(status.username);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const dirty = Boolean(token.trim()) || username.trim() !== status.username;
  useEffect(() => { onDirty(dirty); }, [dirty]);
  useEffect(() => { setUsername(status.username); }, [status.username, status.checkedAt]);
  const pill = credentialPill(status); const id = `integration-first-${program.toLowerCase()}`;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!username.trim()) { setNotice({ tone: "error", text: "Enter the FIRST API username." }); return; }
    if (!token.trim()) { setNotice({ tone: "error", text: status.saved ? "Enter the token again to change the username or token." : "Enter the FIRST API token." }); return; }
    setBusy(true); setNotice(undefined);
    try { const next = await api<FirstStatus>("/admin/integrations/first", { method: "PUT", body: JSON.stringify({ program, username: username.trim(), token: token.trim() }) }); setToken(""); onChanged(next); setNotice({ tone: "success", text: `FIRST accepted the ${program} username and token.` }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove the ${program} username and token? Modules stop looking up ${program} teams, and FIRST's saved ${program} answers are forgotten.`)) return;
    setBusy(true); setNotice(undefined);
    try { const next = await api<FirstStatus>(`/admin/integrations/first?${new URLSearchParams({ program })}`, { method: "DELETE" }); setToken(""); onChanged(next); setNotice({ tone: "success", text: `The ${program} username and token are removed.` }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  return <form className="ui-form first-program" aria-labelledby={`${id}-title`} autoComplete="off" noValidate onSubmit={(event) => void save(event)}>
    <div className="first-program-heading"><h3 id={`${id}-title`}>{program}</h3><span className="status-pill ui-status" data-tone={pill.tone}>{pill.text}</span></div>
    {status.saved && !status.readable && <p className="ui-status" data-tone="warning" role="status">Saved, but can't be read. Save it again.</p>}
    <div className="first-program-fields">
      <label htmlFor={`${id}-username`}>Username<input id={`${id}-username`} name={`${id}-username`} className="ui-control" type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={100} {...passwordManagerIgnore} disabled={busy} value={username} onChange={(event) => { setUsername(event.target.value); setNotice(undefined); }} /></label>
      <label htmlFor={`${id}-token`}>Token<input id={`${id}-token`} name={`${id}-token`} className="ui-control" type="password" autoComplete="new-password" spellCheck={false} maxLength={200} {...passwordManagerIgnore} placeholder={status.saved ? "Saved, hidden" : undefined} disabled={busy} value={token} onChange={(event) => { setToken(event.target.value); setNotice(undefined); }} /></label>
    </div>
    <div className="first-program-actions">
      <button className={`ui-button${status.saved ? "" : " ui-button--primary"}`} type="submit" disabled={busy || !dirty}>{busy ? "Checking with FIRST…" : "Save"}</button>
      {status.saved && <button className="ui-button" type="button" disabled={busy} onClick={() => void remove()}>Remove</button>}
    </div>
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
  </form>;
}

/** The FIRST card in Settings > Integrations. */
export function FirstIntegrationSettings() {
  const [status, setStatus] = useState<FirstStatus>();
  const [loadError, setLoadError] = useState("");
  const [dirty, setDirty] = useState<Partial<Record<EventsProgram, boolean>>>({});
  const [number, setNumber] = useState("");
  const [program, setProgram] = useState<Program>("FRC");
  const [testBusy, setTestBusy] = useState(false);
  const [result, setResult] = useState<Notice>();
  useEffect(() => {
    let current = true;
    api<FirstStatus>("/admin/integrations/first").then((next) => { if (current) setStatus(next); }, (error: Error) => { if (current) setLoadError(error.message); });
    return () => { current = false; };
  }, []);
  // A typed username or token is lost on leaving the page, so the browser asks first, as other settings with unsaved input do.
  const unsaved = Object.values(dirty).some(Boolean);
  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [unsaved]);

  async function lookUp(event: FormEvent) {
    event.preventDefault();
    const typed = number.trim();
    if (!/^[1-9]\d{0,5}$/.test(typed)) { setResult({ tone: "error", text: "Enter a team number of 1 to 6 digits." }); return; }
    setTestBusy(true); setResult(undefined);
    try { setResult(lookupText(program, typed, await api<Lookup>("/admin/integrations/first/lookup", { method: "POST", body: JSON.stringify({ program, number: typed }) }), Boolean(status?.fll.available))); }
    catch (error) { setResult({ tone: "error", text: (error as Error).message }); }
    finally { setTestBusy(false); }
  }
  async function clearCache() {
    setTestBusy(true); setResult(undefined);
    try { setStatus(await api<FirstStatus>("/admin/integrations/first/clear-cache", { method: "POST" })); setResult({ tone: "success", text: "Cached answers cleared. The next lookups ask FIRST again." }); }
    catch (error) { setResult({ tone: "error", text: (error as Error).message }); }
    finally { setTestBusy(false); }
  }

  const pill = cardPill(status);
  return <article className="integration-card ui-card first-integration" aria-labelledby="first-integration-title">
    <div className="first-integration-heading"><h2 id="first-integration-title">FIRST</h2>{pill && <span className="status-pill ui-status" data-tone={pill.tone}>{pill.text}</span>}</div>
    <div className="first-integration-body">
      <p className="first-integration-intro">Looks up FIRST teams by number for any module that needs it. Only the team number is sent to FIRST. Get a username and token from FIRST's{" "}
        <a href={firstApiRegistration.FRC} target="_blank" rel="noreferrer">FRC<span className="visually-hidden"> Events API registration (opens in a new tab)</span></a> and{" "}
        <a href={firstApiRegistration.FTC} target="_blank" rel="noreferrer">FTC Events API registration<span className="visually-hidden"> (opens in a new tab)</span></a>.</p>
      {loadError && <p className="ui-status" data-tone="error" role="alert">{loadError}</p>}
      {status && !status.encryption && <p className="ui-status" data-tone="warning" role="status">Credential encryption is not set up on this installation, so a username and token cannot be saved.</p>}
      {status && eventsPrograms.map((item) => <ProgramCredential key={item} program={item} status={status.programs[item]} onChanged={setStatus} onDirty={(value) => setDirty((current) => current[item] === value ? current : { ...current, [item]: value })} />)}
      {status && <section className="first-program" aria-labelledby="first-fll-title">
        <div className="first-program-heading"><h3 id="first-fll-title">FLL</h3><span className="status-pill ui-status" data-tone={status.fll.available ? "success" : "neutral"}>{status.fll.available ? "Available" : "Not available yet"}</span></div>
        <p className="first-program-note">Uses FIRST's public team search. No username or token needed.</p>
      </section>}
      {status && <form className="ui-form first-test" aria-labelledby="first-test-title" autoComplete="off" noValidate onSubmit={(event) => void lookUp(event)}>
        <h3 id="first-test-title">Test a team</h3>
        <div className="first-test-fields">
          <label htmlFor="integration-first-test-number">Team number<input id="integration-first-test-number" name="integration-first-test-number" className="ui-control" type="text" inputMode="numeric" autoComplete="off" maxLength={6} {...passwordManagerIgnore} disabled={testBusy} value={number} onChange={(event) => setNumber(event.target.value)} /></label>
          <label htmlFor="integration-first-test-program">Program<select id="integration-first-test-program" name="integration-first-test-program" className="ui-control ui-native-select" disabled={testBusy} value={program} onChange={(event) => setProgram(event.target.value as Program)}>{(Object.keys(programLabels) as Program[]).map((item) => <option key={item} value={item}>{programLabels[item]}</option>)}</select></label>
        </div>
        <div className="first-program-actions">
          <button className="ui-button" type="submit" disabled={testBusy}>{testBusy ? "Looking up…" : "Look up"}</button>
          <button className="ui-button" type="button" disabled={testBusy} onClick={() => void clearCache()}>Clear cached answers</button>
        </div>
        {result && <p className="ui-status first-test-result" data-tone={result.tone} role={result.tone === "error" ? "alert" : "status"}>{result.text}</p>}
      </form>}
    </div>
  </article>;
}
