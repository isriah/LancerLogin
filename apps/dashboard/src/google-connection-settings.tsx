import { documentationAvailable } from '../../../packages/shared/src/release-capabilities';
import { GoogleDriveStorageSettings } from './google-drive-storage-settings';
import { FormEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import { api } from "./dashboard-api";

type Summary = { generation: string; loginEnabled: boolean; loginVerified: boolean; calendarEnabled: boolean; driveEnabled: boolean; organizationAuthorized: boolean; grantedScopes: string[]; grantError?: "revoked" | "temporary"; calendarReady: boolean; driveReady: boolean; calendarSelected: boolean; calendarName?: string };
type Snapshot = { revision: number; mode: "legacy" | "shared"; active: Summary | null; candidate: Summary | null; callbackUri: string; loginCallbackUri: string };
type CalendarPage = { revision: number; calendars: { id: string; name: string }[]; nextPageToken?: string };
const root = "/admin/connections/google";
const flags: ("loginEnabled"|"calendarEnabled"|"driveEnabled")[] = ["loginEnabled", "calendarEnabled", ...(documentationAvailable ? ["driveEnabled" as const] : [])];
const labels = { loginEnabled: "Staff Google sign-in", calendarEnabled: "Attendance Calendar", driveEnabled: "Activity Documentation Drive" };
const bounded = (value: unknown, max = 2048): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
function validSummary(value: Summary | null) {
  return value === null || !!value && bounded(value.generation) && [...flags, "loginVerified", "organizationAuthorized", "calendarReady", "driveReady", "calendarSelected"].every(key => typeof value[key as keyof Summary] === "boolean") &&
    Array.isArray(value.grantedScopes) && value.grantedScopes.length <= 32 && value.grantedScopes.every(scope => bounded(scope)) &&
    (value.grantError === undefined || ["revoked", "temporary"].includes(value.grantError)) && (value.calendarName === undefined || bounded(value.calendarName));
}
function validate(value: Snapshot): Snapshot {
  const callback = (uri: unknown, path: string) => { try { const url = new URL(String(uri)); return url.protocol === "https:" && url.pathname === path && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } };
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !["legacy", "shared"].includes(value.mode) || !validSummary(value.active) || !validSummary(value.candidate) ||
      !callback(value.callbackUri, "/api/admin/connections/google/callback") || !callback(value.loginCallbackUri, "/api/auth/google/callback") || new URL(value.callbackUri).origin !== new URL(value.loginCallbackUri).origin) throw Error("Invalid status");
  return value;
}
function ConnectionSummary({ title, value }: { title: string; value: Summary | null }) {
  return <section className="google-summary"><h3>{title}</h3>{!value ? <p>None in the shared connection.</p> : <>
    <dl>{flags.map(flag => <div key={flag}><dt>{labels[flag]}</dt><dd>{value[flag] ? "Enabled" : "Disabled"}</dd></div>)}
      <div><dt>Sign-in proof</dt><dd>{value.loginVerified ? "Verified registered Admin" : "Not verified"}</dd></div>
      <div><dt>Organizational grant</dt><dd>{value.grantError === "revoked" ? "Revoked — authorize again" : value.grantError === "temporary" ? "Temporarily unavailable" : value.organizationAuthorized ? "Stored" : "Not authorized"}</dd></div>
      <div><dt>Calendar capability</dt><dd>{value.calendarReady ? "Ready" : "Not ready"}</dd></div>{documentationAvailable && <div><dt>Drive capability</dt><dd>{value.driveReady ? "Ready" : "Not ready"}</dd></div>}
      <div><dt>Attendance calendar</dt><dd>{value.calendarName ?? (value.calendarSelected ? "Selected" : "Not selected")}</dd></div></dl>
    <details><summary>Actual granted scopes ({value.grantedScopes.length})</summary>{value.grantedScopes.length ? <ul>{value.grantedScopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul> : <p>No scopes reported.</p>}</details>
  </>}</section>;
}

export function GoogleConnectionSettings({ onLegacyAllowed, calendarControls }: { onLegacyAllowed: (allowed: boolean) => void; calendarControls?: ReactNode }) {
  const id = useId(); const messageRef = useRef<HTMLParagraphElement>(null); const lock = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot>(); const [busy, setBusy] = useState(false); const [mustReload, setMustReload] = useState(true);
  const [notice, setNotice] = useState<{ error: boolean; text: string; focus?: boolean }>();
  const [draft, setDraft] = useState({ loginEnabled: false, calendarEnabled: false, driveEnabled: false });
  const [replace, setReplace] = useState(false); const [clientId, setClientId] = useState(""); const [secret, setSecret] = useState("");
  const [page, setPage] = useState<CalendarPage>(); const [calendar, setCalendar] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [consent, setConsent] = useState<string[]>([]);
  function accept(next: Snapshot) {
    setSnapshot(next); setMustReload(false); setPage(undefined); setCalendar(""); setConfirmation("");
    const value = next.candidate ?? next.active; setDraft({ loginEnabled: value?.loginEnabled ?? false, calendarEnabled: value?.calendarEnabled ?? false, driveEnabled: documentationAvailable && (value?.driveEnabled ?? false) });
    setConsent([...(value?.calendarEnabled ? ["calendar"] : []), ...(documentationAvailable && value?.driveEnabled ? ["drive"] : [])]);
    onLegacyAllowed(next.mode === "legacy" && !next.candidate && !next.active);
  }
  async function read() { return validate(await api<Snapshot>(root)); }
  function failed() { setMustReload(true); onLegacyAllowed(false); setNotice({ error: true, text: "The result could not be confirmed. Reload Google connection to review current server settings before trying again. Check that you are still an Admin, the required proofs and scopes are complete, and a local Admin password remains usable. For replacement, keep the existing attendance calendar. No change will be retried automatically." }); }
  async function reload(callback?: string) {
    if (lock.current) return; lock.current = true; setBusy(true); onLegacyAllowed(false);
    try { accept(await read()); setNotice({ error: callback === "failed", text: callback === "failed" ? "Google authorization did not complete. Current server settings are shown. Review the candidate and explicitly authorize again when ready." : callback === "review" ? "Returned from Google. Review the actual proofs below before promoting the candidate." : "Current Google connection reloaded." }); }
    catch { failed(); } finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => { const url = new URL(window.location.href); const callback = url.searchParams.get("googleConnection") ?? undefined; url.searchParams.delete("googleConnection"); window.history.replaceState({}, "", url); void reload(callback); }, []);
  useEffect(() => { if (notice?.error || notice?.focus) messageRef.current?.focus(); }, [notice]);
  async function mutate(path: string, method: string, body: Record<string, unknown>) {
    if (!snapshot || lock.current || mustReload) return; lock.current = true; setBusy(true); onLegacyAllowed(false); setSecret("");
    try {
      const written = validate(await api<Snapshot>(root + path, { method, body: JSON.stringify({ revision: snapshot.revision, ...body }) }));
      const current = await read(); if (current.revision !== written.revision || current.revision <= snapshot.revision) throw Error("Changed status");
      accept(current); setClientId(""); setReplace(false); setNotice({ error: false, focus: true, text: "Change confirmed by reloading the server. Review the current connection below." });
    } catch { failed(); } finally { lock.current = false; setBusy(false); }
  }
  async function stage(event: FormEvent) { event.preventDefault(); const credentials = !snapshot?.active || replace ? { clientId: clientId.trim(), clientSecret: secret } : {}; await mutate("/candidate", "POST", { ...draft, ...credentials }); }
  async function authorize(purpose: "login-proof" | "organization") {
    if (!snapshot || lock.current || mustReload) return; lock.current = true; setBusy(true); onLegacyAllowed(false);
    try {
      const result = await api<{ authorizationUrl: string }>(root + "/authorize", { method: "POST", body: JSON.stringify({ revision: snapshot.revision, purpose, capabilities: purpose === "organization" ? consent : [] }) });
      if (!bounded(result?.authorizationUrl, 8192)) throw Error("Invalid authorization destination"); const url = new URL(result.authorizationUrl); if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.hash || url.searchParams.get("redirect_uri") !== snapshot.callbackUri) throw Error("Invalid authorization destination");
      window.location.assign(url.href);
    } catch { failed(); lock.current = false; setBusy(false); }
  }
  async function calendars(next = false) {
    if (!snapshot || lock.current || mustReload) return; lock.current = true; setBusy(true);
    try {
      const result = await api<CalendarPage>(root + "/calendars?revision=" + snapshot.revision + (next && page?.nextPageToken ? "&pageToken=" + encodeURIComponent(page.nextPageToken) : ""));
      if (!result || result.revision !== snapshot.revision || !Array.isArray(result.calendars) || result.calendars.length > 100 || !result.calendars.every(item => bounded(item?.id, 1024) && bounded(item?.name)) || (result.nextPageToken !== undefined && !bounded(result.nextPageToken))) throw Error("Invalid calendars");
      setPage(result); setCalendar(""); setNotice({ error: false, text: "Writable calendars loaded. Choose a calendar from this page." });
    } catch { failed(); } finally { lock.current = false; setBusy(false); }
  }
  const blocked = busy || mustReload; const candidate = snapshot?.candidate;
  const canPromote = candidate && (!candidate.loginEnabled || candidate.loginVerified) && (!candidate.calendarEnabled || candidate.calendarReady) && (!candidate.driveEnabled || candidate.driveReady);
  return <><section className="integration-card google-connection" aria-labelledby={`${id}-title`}>
    <div className="google-actions"><h2 id={`${id}-title`}>Google connection</h2><button type="button" disabled={busy} onClick={() => void reload()}>Reload Google connection</button></div>
    <p>One OAuth client per installation. Staff sign-in and the organizational Calendar/Drive grant are separate; they may use different Google accounts.</p>
    {notice && <p ref={messageRef} tabIndex={-1} role={notice.error ? "alert" : "status"} className="ui-status settings-notice" data-tone={notice.error ? "error" : "success"}>{notice.text}</p>}
    {busy && <p role="status">Working on Google connection…</p>}
    {snapshot && <>
      <p>{snapshot.mode === "legacy" ? "Legacy configuration stays active until verified promotion. Saved legacy repair controls are available only while no candidate is staged; cancel a candidate to restore legacy repair." : "Shared connection mode."}</p>
      <div className="google-summaries"><ConnectionSummary title="Active connection" value={snapshot.active} /><ConnectionSummary title="Candidate connection" value={snapshot.candidate} /></div>
      {snapshot.active?.calendarEnabled && <section className="google-stack"><h3>Attendance Calendar delivery</h3><p>Only generic event names and timing are sent. Existing mappings and automatic retry behavior are preserved.</p><fieldset disabled={blocked || !snapshot.active.calendarReady}><legend>Delivery controls</legend>{calendarControls}</fieldset></section>}
      <p>Keep a working local Admin password before replacing or removing credentials. In <a href="/settings/access">Access settings</a>, register an active Google Admin before taking a sign-in proof. The local Admin initiating setup can verify that registered Google account; the organizational account is independent.</p>
      <details><summary>One-client setup and exact callbacks</summary><div className="google-stack"><p>In Google Auth Platform, configure Branding and Audience, then create one Web application client. Enable Calendar API for attendance. For External Testing, add the intended test accounts. Register both exact redirect URIs:</p><label>Staff sign-in callback<input readOnly value={snapshot.loginCallbackUri} /></label><label>Connection proof callback<input readOnly value={snapshot.callbackUri} /></label><p>Sign-in requests openid, email and profile. Calendar requests calendar.calendarlist.readonly and calendar.events.</p><a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Open Google Auth Platform</a></div></details>
      {!candidate ? <form onSubmit={stage} className="google-stack"><h3>Stage a connection</h3><p>Changes stay in a candidate until verification and explicit promotion. Disabled purposes retain existing grants.</p>
        <fieldset disabled={blocked}><legend>Purposes to enable</legend>{flags.map(flag => <label className="module-choice" key={flag}><input type="checkbox" checked={draft[flag]} onChange={event => setDraft({ ...draft, [flag]: event.target.checked })} />{labels[flag]}</label>)}</fieldset>
        {snapshot.active && <label className="module-choice"><input disabled={blocked} type="checkbox" checked={replace} onChange={event => { setReplace(event.target.checked); setSecret(""); }} />Replace the OAuth client</label>}
        {(!snapshot.active || replace) && <><label htmlFor={`${id}-client`}>OAuth client ID</label><input id={`${id}-client`} required disabled={blocked} value={clientId} autoComplete="off" maxLength={500} onChange={event => setClientId(event.target.value)} /><label htmlFor={`${id}-secret`}>OAuth client secret</label><input id={`${id}-secret`} type="password" required disabled={blocked} autoComplete="new-password" value={secret} maxLength={500} aria-describedby={`${id}-secret-help`} onChange={event => setSecret(event.target.value)} /><p id={`${id}-secret-help`}>Use a password manager for your recovery copy. The saved secret is never returned, and this field clears after submission.</p></>}
        <div className="google-actions"><button className="primary-button" disabled={blocked}>Stage Google connection</button></div></form> : <div className="google-stack"><h3>Verify and review candidate</h3>
        <p>Authorize each required purpose. Existing Calendar destinations must be retained during replacement; moving attendance calendars requires a separate migration.</p>
        <div className="google-actions"><button disabled={blocked || !candidate.loginEnabled} onClick={() => void authorize("login-proof")}>Verify registered Admin sign-in</button></div>
        <fieldset disabled={blocked}><legend>Organizational consent capabilities</legend>{["calendar", ...(documentationAvailable ? ["drive"] : [])].map(capability => <label className="module-choice" key={capability}><input type="checkbox" checked={consent.includes(capability)} onChange={event => setConsent(event.target.checked ? [...consent, capability] : consent.filter(item => item !== capability))} />{capability === "calendar" ? "Calendar consent" : "Drive consent"}</label>)}</fieldset>
        <div className="google-actions"><button disabled={blocked || !consent.length} onClick={() => void authorize("organization")}>Authorize organizational account</button></div>
        {candidate.calendarEnabled && <div className="google-stack"><div className="google-actions"><button disabled={blocked || !candidate.organizationAuthorized} onClick={() => void calendars()}>Load writable calendars</button></div>{page && <><label htmlFor={`${id}-calendar`}>Candidate attendance calendar</label><select id={`${id}-calendar`} disabled={blocked} value={calendar} onChange={event => setCalendar(event.target.value)}><option value="">Choose from this page</option>{page.calendars.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{!page.calendars.length && <p>No writable calendars on this page.</p>}<div className="google-actions"><button disabled={blocked || !calendar} onClick={() => void mutate("/calendar", "PUT", { calendarId: calendar })}>Verify selected calendar</button>{page.nextPageToken && <button disabled={blocked} onClick={() => void calendars(true)}>Next calendar page</button>}</div></>}</div>}
        <p>Promotion replaces active settings only after server verification and local recovery checks. “Not ready” can mean missing scopes, a missing calendar proof, a disabled purpose, or a revoked grant.</p>
        <div className="google-actions"><button className="primary-button" disabled={blocked || !canPromote} onClick={() => void mutate("/promote", "POST", {})}>Promote verified candidate</button><button disabled={blocked} onClick={() => void mutate("/candidate", "DELETE", {})}>Cancel candidate</button></div>
      </div>}
      {snapshot.mode === "shared" && (snapshot.active || candidate) && <details><summary>Remove Google connection</summary><div className="google-stack"><p id={`${id}-remove-help`}>Removal turns off Google sign-in and clears local Calendar mappings and pending operations. Existing Google events and account grants are not deleted. A usable local Admin password is required. Type REMOVE GOOGLE CONNECTION to confirm.</p><label htmlFor={`${id}-remove`}>Removal confirmation</label><input id={`${id}-remove`} value={confirmation} disabled={blocked} autoComplete="off" aria-describedby={`${id}-remove-help`} onChange={event => setConfirmation(event.target.value)} /><div className="google-actions"><button className="danger-button" disabled={blocked || confirmation !== "REMOVE GOOGLE CONNECTION"} onClick={() => void mutate("", "DELETE", { confirmation })}>Remove shared Google connection</button></div></div></details>}
    </>}
  </section>{documentationAvailable && <GoogleDriveStorageSettings key={snapshot?.revision??'loading'} available={!!snapshot?.active?.driveReady&&!blocked} />}</>;
}
