import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "./dashboard-api";
import { NotionBindingControl, notionUsable, type NotionCapabilityState, type NotionStatus } from "./notion-binding-field";
import "./notion-integration-settings.css";

// Settings > Integrations > Notion: Core's one Notion connection, which modules use through services.notion. An Admin
// saves an integration token (checked with Notion, then stored encrypted and never shown again), turns the connection on
// or off, checks it again, removes it, sees what the token has been seen to allow, and chooses the database for each
// binding an installed module declared.

type Notice = { tone: "success" | "error" | "warning" | "neutral"; text: string };

/** Where an Admin creates the integration and copies its token. */
export const notionIntegrationsPage = "https://www.notion.so/profile/integrations";
// Browsers and password managers treat a lone password input as a sign-in form, so this one opts out.
const passwordManagerIgnore = { "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" } as const;

const checkedDate = (value: string | null) => { const date = value ? new Date(value) : undefined; return date && !Number.isNaN(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""; };

/** The card's one-line state. */
export function notionCardPill(status?: NotionStatus): Notice | undefined {
  if (!status) return undefined;
  if (!status.saved) return { tone: "neutral", text: "Not connected" };
  if (!status.readable) return { tone: "warning", text: "Saved, but can't be read" };
  if (!status.enabled) return { tone: "neutral", text: "Turned off" };
  return { tone: "success", text: "Connected" };
}

/** The five capabilities a Notion integration is given, in Notion's own words, with what Core has seen of each. */
export function notionCapabilityRows(capabilities: NotionStatus["capabilities"]): { id: string; label: string; state: NotionCapabilityState; note?: string }[] {
  return [
    { id: "read", label: "Read content", state: capabilities.read },
    { id: "insert", label: "Insert content", state: capabilities.insert },
    { id: "update", label: "Update content", state: capabilities.update },
    { id: "comment", label: "Insert comments", state: capabilities.comment },
    { id: "users", label: "Read user information", state: capabilities.users, ...(capabilities.users === "ok" && capabilities.email !== "unknown" ? { note: capabilities.email === "ok" ? "Including email addresses" : "Without email addresses" } : {}) },
  ];
}
const capabilityPill: Record<NotionCapabilityState, Notice> = { ok: { tone: "success", text: "Working" }, refused: { tone: "error", text: "Refused by Notion" }, unknown: { tone: "neutral", text: "Not used yet" } };

/** The Notion card in Settings > Integrations. */
export function NotionIntegrationSettings() {
  const [status, setStatus] = useState<NotionStatus>();
  const [loadError, setLoadError] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "toggle" | "remove">();
  const [notice, setNotice] = useState<Notice>();
  useEffect(() => {
    let current = true;
    api<NotionStatus>("/admin/integrations/notion").then((next) => { if (current) setStatus(next); }, (error: Error) => { if (current) setLoadError(error.message); });
    return () => { current = false; };
  }, []);
  // A typed token is lost on leaving the page, so the browser asks first, as other settings with unsaved input do.
  const unsaved = Boolean(token.trim());
  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [unsaved]);

  async function change(kind: NonNullable<typeof busy>, request: () => Promise<NotionStatus>, done: string) {
    setBusy(kind); setNotice(undefined);
    try { setStatus(await request()); setNotice({ tone: "success", text: done }); return true; }
    catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
      // Someone else changed the connection since this page loaded: show what is saved now, so the next try starts from it.
      if (error instanceof ApiError && error.status === 409) await api<NotionStatus>("/admin/integrations/notion").then(setStatus, () => undefined);
      return false;
    }
    finally { setBusy(undefined); }
  }
  // Each change names the revision this page loaded, so it cannot silently undo a change made in another window.
  const put = (body: Record<string, unknown>) => api<NotionStatus>("/admin/integrations/notion", { method: "PUT", body: JSON.stringify({ ...body, revision: status?.revision ?? 0 }) });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) { setNotice({ tone: "error", text: "Enter the Notion integration token." }); return; }
    if (await change("save", () => put({ token: token.trim() }), "Notion accepted the token.")) setToken("");
  }
  async function remove() {
    if (!window.confirm("Remove the Notion token? Modules stop using Notion until a token is saved again. The databases chosen below are kept.")) return;
    if (await change("remove", () => api<NotionStatus>("/admin/integrations/notion", { method: "DELETE" }), "The Notion token is removed.")) setToken("");
  }

  const pill = notionCardPill(status); const working = busy !== undefined;
  return <article className="integration-card ui-card notion-integration" aria-labelledby="notion-integration-title">
    <div className="notion-integration-heading"><h2 id="notion-integration-title">Notion</h2>{pill && <span className="status-pill ui-status" data-tone={pill.tone}>{pill.text}</span>}</div>
    <div className="notion-integration-body">
      <p className="notion-note notion-integration-intro">One Notion connection for every module that needs it. Create an internal integration in Notion's{" "}
        <a href={notionIntegrationsPage} target="_blank" rel="noreferrer">integration settings<span className="visually-hidden"> (opens in a new tab)</span></a>, copy its token here, then add the integration to each database a module uses.</p>
      {loadError && <p className="ui-status" data-tone="error" role="alert">{loadError}</p>}
      {status && !status.encryption && <p className="ui-status" data-tone="warning" role="status">Credential encryption is not set up on this installation, so a token cannot be saved.</p>}
      {status && <form className="ui-form notion-section" aria-labelledby="notion-token-title" autoComplete="off" noValidate onSubmit={(event) => void save(event)}>
        <div className="notion-section-heading">
          <h3 id="notion-token-title">Connection</h3>
          {/* The switch is not disabled while its request runs: a disabled control drops keyboard focus. Presses wait instead. */}
          {status.saved && <label className="integration-toggle"><input type="checkbox" role="switch" aria-label="Enable Notion" checked={status.enabled} aria-busy={busy === "toggle"} onChange={(event) => { if (working) return; const enabled = event.target.checked; void change("toggle", () => put({ enabled }), enabled ? "Notion is turned on." : "Notion is turned off. The token is kept."); }} /><span>{status.enabled ? "On" : "Off"}</span></label>}
        </div>
        {status.saved && !status.readable && <p className="ui-status" data-tone="warning" role="status">Saved, but can't be read. Save it again.</p>}
        {status.saved && status.readable && <p className="notion-note">{status.botName ? `Connected as ${status.botName}` : "Connected"}{status.workspaceName ? ` in ${status.workspaceName}` : ""}.{checkedDate(status.checkedAt) ? ` Checked ${checkedDate(status.checkedAt)}.` : ""}</p>}
        {status.pausedUntil && <p className="ui-status" data-tone="warning" role="status">Notion asked LancerLogin to slow down. Calls resume at {new Date(status.pausedUntil).toLocaleTimeString(undefined, { timeStyle: "short" })}.</p>}
        <label htmlFor="integration-notion-token">Integration token<input id="integration-notion-token" name="integration-notion-token" className="ui-control" type="password" autoComplete="new-password" spellCheck={false} maxLength={500} {...passwordManagerIgnore} placeholder={status.saved ? "Saved, hidden" : undefined} disabled={working || !status.encryption} value={token} onChange={(event) => { setToken(event.target.value); setNotice(undefined); }} /></label>
        <div className="notion-actions">
          <button className={`ui-button${status.saved ? "" : " ui-button--primary"}`} type="submit" disabled={working || !token.trim()}>{busy === "save" ? "Checking with Notion…" : "Save"}</button>
          {status.saved && status.readable && <button className="ui-button" type="button" disabled={working} onClick={() => void change("check", () => put({ check: true }), "Notion accepted the saved token.")}>{busy === "check" ? "Checking…" : "Check"}</button>}
          {status.saved && <button className="ui-button" type="button" disabled={working} onClick={() => void remove()}>Remove</button>}
        </div>
        {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      </form>}
      {status?.saved && <section className="notion-section" aria-labelledby="notion-capabilities-title">
        <h3 id="notion-capabilities-title">What the token allows</h3>
        <p className="notion-note">Notion does not list an integration's capabilities, so each one shows what LancerLogin has seen when a module used it. Change them in the integration's settings in Notion.</p>
        <ul className="notion-capabilities">{notionCapabilityRows(status.capabilities).map((row) => <li key={row.id}>
          <span className="notion-capability-label">{row.label}{row.note && <span className="notion-note"> {row.note}</span>}</span>
          <span className="status-pill ui-status" data-tone={capabilityPill[row.state].tone}>{capabilityPill[row.state].text}</span>
        </li>)}</ul>
      </section>}
      {status && <section className="notion-section" aria-labelledby="notion-bindings-title">
        <h3 id="notion-bindings-title">Databases</h3>
        {status.bindings.length === 0 ? <p className="notion-note">No installed module uses Notion yet.</p> : <>
          <p className="notion-note">Each module can use only the databases chosen here. In Notion, add the integration to a database before choosing it.</p>
          <ul className="notion-bindings">{status.bindings.map((binding) => <li key={`${binding.moduleId}:${binding.id}`}>
            <p className="notion-binding-module">{binding.moduleLabel}</p>
            <NotionBindingControl binding={binding} usable={notionUsable(status)} onChanged={setStatus} />
          </li>)}</ul>
        </>}
      </section>}
    </div>
  </article>;
}
