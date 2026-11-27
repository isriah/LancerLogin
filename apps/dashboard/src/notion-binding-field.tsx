import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "./dashboard-api";
import "./notion-integration-settings.css";

// One Notion database a module declared in its manifest (`notion.bindings`), chosen by an Admin. Core's Notion card in
// Settings > Integrations lists every binding with NotionBindingControl; a plugin's Admin-only setup or settings page
// places NotionBindingField (module SDK 1.8.0) for one of its own. Core stores the choice and checks the database with its
// own connection, so the token never reaches a plugin page.

export type NotionCapabilityState = "ok" | "refused" | "unknown";
export type NotionBindingStatus = {
  moduleId: string; moduleLabel: string; id: string; label: string; reason: string; required: boolean; operations: string[];
  bound: boolean; databaseId: string | null; dataSourceId: string | null; name: string; link: string | null;
};
export type NotionStatus = {
  saved: boolean; enabled: boolean; readable: boolean; encryption: boolean; botName: string; workspaceName: string; checkedAt: string | null; pausedUntil: string | null;
  capabilities: Record<"read" | "insert" | "update" | "comment" | "users" | "email", NotionCapabilityState>; revision: number; bindings: NotionBindingStatus[];
};
type DataSource = { id: string; name: string };
type BindingReply = { bound: boolean; dataSources: DataSource[]; integration: NotionStatus };
type Notice = { tone: "success" | "error" | "warning" | "neutral"; text: string };

export const notionBindingPath = (moduleId: string, bindingId: string) => `/admin/integrations/notion/bindings/${encodeURIComponent(moduleId)}/${encodeURIComponent(bindingId)}`;
/** Whether Core can call Notion now: a token is saved, readable and turned on. */
export const notionUsable = (status: Pick<NotionStatus, "saved" | "enabled" | "readable">) => status.saved && status.enabled && status.readable;
/** Why a database cannot be chosen yet, in words an Admin can act on, or undefined when it can. */
export function notionBlocker(status: Pick<NotionStatus, "saved" | "enabled" | "readable">): string | undefined {
  if (!status.saved) return "Connect Notion first.";
  if (!status.readable) return "The saved Notion token can't be read. Save it again first.";
  if (!status.enabled) return "Turn the Notion connection on first.";
  return undefined;
}

/**
 * The control for one binding: the database chosen now, a field for a Notion link or ID, and Clear. A database with
 * several data sources asks which one before anything is saved.
 */
export function NotionBindingControl({ binding, usable, onChanged }: { binding: NotionBindingStatus; usable: boolean; onChanged: (status: NotionStatus) => void }) {
  // Named like the other integration fields (`integration-...`, id equal to name), so browsers do not offer sign-in autofill.
  const id = `integration-notion-${binding.moduleId}-${binding.id}`;
  const [link, setLink] = useState("");
  const [choices, setChoices] = useState<DataSource[]>([]);
  const [dataSourceId, setDataSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const path = notionBindingPath(binding.moduleId, binding.id);

  async function choose(event: FormEvent) {
    event.preventDefault();
    if (!link.trim()) { setNotice({ tone: "error", text: "Paste the database's link from Notion." }); return; }
    if (choices.length && !dataSourceId) { setNotice({ tone: "error", text: "Choose a data source." }); return; }
    setBusy(true); setNotice(undefined);
    try {
      const reply = await api<BindingReply>(path, { method: "PUT", body: JSON.stringify({ database: link.trim(), ...(choices.length ? { dataSourceId } : {}) }) });
      if (reply.bound) { setLink(""); setChoices([]); setDataSourceId(""); onChanged(reply.integration); setNotice({ tone: "success", text: "Database saved." }); }
      else { setChoices(reply.dataSources); setDataSourceId(reply.dataSources[0]?.id ?? ""); setNotice({ tone: "neutral", text: "This database has more than one data source. Choose one, then save." }); }
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!window.confirm(`Clear the database for ${binding.label}? ${binding.moduleLabel} stops using it until you choose one again.`)) return;
    setBusy(true); setNotice(undefined);
    try { const reply = await api<BindingReply>(path, { method: "DELETE" }); setLink(""); setChoices([]); onChanged(reply.integration); setNotice({ tone: "success", text: "Database cleared." }); }
    catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }

  return <form className="ui-form notion-binding" aria-labelledby={`${id}-title`} autoComplete="off" noValidate onSubmit={(event) => void choose(event)}>
    <div className="notion-binding-heading">
      <h4 id={`${id}-title`}>{binding.label}{!binding.required && <span className="notion-binding-optional"> (optional)</span>}</h4>
      <span className="status-pill ui-status" data-tone={binding.bound ? "success" : binding.required ? "warning" : "neutral"}>{binding.bound ? "Chosen" : "Not chosen"}</span>
    </div>
    <p className="notion-note" id={`${id}-reason`}>{binding.reason}</p>
    {binding.bound && binding.link && <p className="notion-binding-current">Database: <a href={binding.link} target="_blank" rel="noreferrer">{binding.name || "Open in Notion"}<span className="visually-hidden"> (opens in a new tab)</span></a></p>}
    <div className="notion-binding-fields">
      <label htmlFor={`${id}-link`}>{binding.bound ? "Change to another database link" : "Database link"}<input id={`${id}-link`} name={`${id}-link`} className="ui-control" type="text" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={2000} aria-describedby={`${id}-reason`} disabled={busy || !usable} value={link} onChange={(event) => { setLink(event.target.value); setChoices([]); setNotice(undefined); }} /></label>
      {choices.length > 0 && <label htmlFor={`${id}-source`}>Data source<select id={`${id}-source`} name={`${id}-source`} className="ui-control ui-native-select" disabled={busy} value={dataSourceId} onChange={(event) => setDataSourceId(event.target.value)}>{choices.map((source) => <option key={source.id} value={source.id}>{source.name || "Untitled data source"}</option>)}</select></label>}
    </div>
    <div className="notion-actions">
      <button className={`ui-button${binding.bound ? "" : " ui-button--primary"}`} type="submit" disabled={busy || !usable || !link.trim()}>{busy ? "Checking with Notion…" : "Save database"}</button>
      {binding.bound && <button className="ui-button" type="button" disabled={busy} onClick={() => void clear()}>Clear</button>}
    </div>
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
  </form>;
}

/**
 * A card with the picker for one of a module's own Notion databases, for an Admin-only module setup or settings page.
 * `onChanged` is told whether the binding has a database, on load and after each change.
 */
export function NotionBindingField({ moduleId, bindingId, onChanged }: { moduleId: string; bindingId: string; onChanged?: (bound: boolean) => void }) {
  const id = useId();
  const [status, setStatus] = useState<NotionStatus>();
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let current = true;
    api<NotionStatus>("/admin/integrations/notion").then((next) => { if (current) setStatus(next); }, (error: Error) => { if (current) setLoadError(error.message); });
    return () => { current = false; };
  }, []);
  const binding = status?.bindings.find((item) => item.moduleId === moduleId && item.id === bindingId);
  const bound = binding?.bound;
  useEffect(() => { if (bound !== undefined) onChanged?.(bound); }, [bound]);
  const blocker = status ? notionBlocker(status) : undefined;
  return <article className="ui-card notion-binding-card" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Notion database</h2>
    {loadError && <p className="ui-status" data-tone="error" role="alert">{loadError}</p>}
    {!status && !loadError && <p className="ui-status" role="status">Loading the Notion connection…</p>}
    {status && blocker && <p className="ui-status" data-tone="warning" role="status">{blocker} <a href="/settings/integrations">Open Settings &gt; Integrations</a></p>}
    {status && !binding && <p className="ui-status" data-tone="error" role="alert">This module did not declare a Notion database named "{bindingId}".</p>}
    {status && binding && <NotionBindingControl binding={binding} usable={notionUsable(status)} onChanged={setStatus} />}
  </article>;
}
