import { documentationAvailable } from '../../../packages/shared/src/release-capabilities';
import { FormEvent, useEffect, useId, useState } from "react";
import { api } from "./dashboard-api";

type Module = { id: string; enabled: boolean; dependencies: string[]; capabilities: string[]; navigation: { label: string } };
type Snapshot = { revision: number; modules: Module[] };
type Grants = { userId: string; capabilities: string[] };
type Notice = { tone: "success" | "error"; text: string };
const labels: Record<string, string> = { "hours.manage": "Manage Hour Tracking", "documentation.manage": "Manage Activity Documentation" };
const summary = (capabilities: string[]) => capabilities.map(capability => labels[capability] ?? capability).join(", ") || "None";
const same = (a: string[], b: string[]) => a.length === b.length && a.every(value => b.includes(value));
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(item => item !== value) : [...values, value];

async function loadModules(): Promise<Snapshot> {
  const result = await api<Snapshot>("/platform/modules");
  // Do not render an empty/default configuration when an older API lacks this contract.
  if (!Number.isSafeInteger(result.revision) || !Array.isArray(result.modules) || result.modules.length !== (documentationAvailable ? 2 : 1) ||
      !["hour-tracking", ...(documentationAvailable ? ["activity-documentation"] : [])].every(id => result.modules.some(module => module.id === id && typeof module.enabled === "boolean" && Array.isArray(module.dependencies) && Array.isArray(module.capabilities) && typeof module.navigation?.label === "string"))) {
    throw new Error("Module settings are unavailable. Reload after checking the application connection.");
  }
  return result;
}

function Feedback({ notice }: { notice?: Notice }) {
  return notice ? <p className="ui-status settings-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p> : null;
}

export function ModuleSettings() {
  const [stored, setStored] = useState<Snapshot>();
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [mustReload, setMustReload] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const id = useId();
  function accept(snapshot: Snapshot) { setStored(snapshot); setDraft(snapshot.modules.filter(module => module.enabled).map(module => module.id)); setMustReload(false); }
  async function reload() {
    setBusy(true); setNotice(undefined);
    try { accept(await loadModules()); } catch (error) { setMustReload(true); setNotice({ tone: "error", text: (error as Error).message }); } finally { setBusy(false); }
  }
  useEffect(() => { void reload(); }, []);
  const invalid = !!stored?.modules.some(module => draft.includes(module.id) && module.dependencies.some(dependency => !draft.includes(dependency)));
  const changed = !!stored && !same(draft, stored.modules.filter(module => module.enabled).map(module => module.id));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!stored || busy || mustReload || invalid || !changed) return;
    setBusy(true); setNotice(undefined);
    try {
      await api("/admin/modules", { method: "PUT", body: JSON.stringify({ enabled: draft, revision: stored.revision }) });
      accept(await loadModules());
      setNotice({ tone: "success", text: "Module configuration saved. Current server settings are shown." });
    } catch (error) {
      setMustReload(true);
      setNotice({ tone: "error", text: `${(error as Error).message} Reload module settings to review the current server state before saving again. Your draft has not been reapplied.` });
    } finally { setBusy(false); }
  }
  return <section className="module-controls" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Modules</h2>
    <p id={`${id}-help`}>Enable modules for this installation. Disabling a module preserves its historical records, files, staff grants, and shared provider connections.</p>
    <Feedback notice={notice} />
    {busy && <p role="status">Loading or saving module settings…</p>}
    {stored && <form onSubmit={save}>
      <p>Last loaded configuration: {stored.modules.filter(module => module.enabled).map(module => module.navigation.label).join(" + ") || "Core only"}.</p>
      <fieldset disabled={busy || mustReload} aria-describedby={documentationAvailable ? `${id}-help ${id}-dependency` : `${id}-help`}>
        <legend>Enabled modules</legend>
        {stored.modules.map(module => <label className="module-choice" key={module.id}><input type="checkbox" checked={draft.includes(module.id)} onChange={() => setDraft(toggle(draft, module.id))} /><span>{module.navigation.label}</span></label>)}
      </fieldset>
      {documentationAvailable && <p id={`${id}-dependency`} className="field-help">Activity Documentation requires Hour Tracking. To disable Hour Tracking while documentation is enabled, explicitly uncheck both modules before saving.</p>}
      {invalid && <p className="ui-status" data-tone="error" role="alert">Activity Documentation cannot be enabled alone. Enable Hour Tracking or uncheck Activity Documentation.</p>}
      <div className="module-actions"><button className="primary-button" type="submit" disabled={busy || mustReload || invalid || !changed}>Save modules</button><button className="quiet-button" type="button" disabled={busy} onClick={() => void reload()}>Reload module settings</button></div>
    </form>}
    {!stored && !busy && <button className="quiet-button" type="button" onClick={() => void reload()}>Reload module settings</button>}
  </section>;
}

export function ModuleGrantControls({ userId, name, role, active }: { userId: string; name: string; role: "admin" | "operator" | "staff"; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<Grants>();
  const [modules, setModules] = useState<Module[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const id = useId();
  const path = `/admin/modules/grants/${encodeURIComponent(userId)}`;
  async function read() {
    const [grants, snapshot] = await Promise.all([api<Grants>(path), loadModules()]);
    if (grants.userId !== userId || !Array.isArray(grants.capabilities) || grants.capabilities.some(value => !labels[value])) throw new Error("Module grants are unavailable.");
    setStored(grants); setDraft(grants.capabilities); setModules(snapshot.modules); setMustReload(false);
  }
  async function reload() {
    setBusy(true); setNotice(undefined);
    try { await read(); } catch (error) { setMustReload(true); setNotice({ tone: "error", text: (error as Error).message }); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || mustReload || !stored || same(stored.capabilities, draft)) return;
    setBusy(true); setNotice(undefined);
    try {
      await api(path, { method: "PUT", body: JSON.stringify({ capabilities: draft }) });
      await read();
      setNotice({ tone: "success", text: "Module grants saved. Current server grants are shown." });
    } catch (error) {
      setMustReload(true);
      setNotice({ tone: "error", text: `${(error as Error).message} Reload grants to review the current server state before saving again. Your draft has not been reapplied.` });
    } finally { setBusy(false); }
  }
  if (role === "admin") return <p className="module-grants-summary">Admins have full access to every enabled module. Explicit grants are not needed.</p>;
  if (!active) return <p className="module-grants-summary">Inactive accounts cannot use module access. Existing grants are retained; activate the account to review or change them.</p>;
  return <div className="module-grants">
    <button className="quiet-button" type="button" disabled={busy} aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open); if (!open) void reload(); }}>Module access for {name}</button>
    {open && <form id={id} className="module-controls" aria-label={`Module access for ${name}`} onSubmit={save}>
      <p id={`${id}-help`}>Staff and Operators need explicit module grants. Grants remain saved while a module is disabled and become usable when its required modules are enabled.</p>
      <Feedback notice={notice} />
      {busy && <p role="status">Loading or saving module grants…</p>}
      {stored && <><p>Last loaded grants: {summary(stored.capabilities)}.</p><fieldset disabled={busy || mustReload} aria-describedby={`${id}-help`}><legend>Module management grants</legend>
        {modules.flatMap(module => module.capabilities.map(capability => <label key={capability} className="module-choice"><input type="checkbox" checked={draft.includes(capability)} onChange={() => setDraft(toggle(draft, capability))} /><span>{labels[capability]} — {module.enabled ? "module enabled" : "module disabled"}</span></label>))}
      </fieldset></>}
      <div className="module-actions"><button type="submit" className="primary-button" disabled={busy || mustReload || !stored || same(stored.capabilities, draft)}>Save grants</button><button className="quiet-button" type="button" disabled={busy} onClick={() => void reload()}>Reload grants</button></div>
    </form>}
  </div>;
}
