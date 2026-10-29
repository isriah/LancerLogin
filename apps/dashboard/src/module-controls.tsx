import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { isFirstPartyModule, recommendedModuleIds, type ModulePlatformSnapshot, type ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import { readModuleSnapshot } from "./module-client";
import { ModuleAccessGrants } from "./module-access-grants";
import { PluginManagement } from "./plugin-management";

type Notice = { tone: "success" | "error"; text: string };
type Assignments = { userId: string; revision: number; capabilities: string[] };
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value) => right.includes(value));
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
const enabledIds = (snapshot?: ModulePlatformSnapshot) => snapshot?.modules.filter((module) => module.enabled).map((module) => module.id) ?? [];
// A fresh installation starts with the recommended modules selected; after that the saved selection is the draft.
const initialDraft = (snapshot?: ModulePlatformSnapshot) => snapshot && !snapshot.selectionCompleted ? snapshot.modules.filter((module) => module.enabled || recommendedModuleIds.includes(module.id) && !module.unavailable && module.phase !== "deleting").map((module) => module.id) : enabledIds(snapshot);
const serverKey = (snapshot?: ModulePlatformSnapshot) => snapshot ? JSON.stringify([snapshot.revision, snapshot.selectionCompleted, enabledIds(snapshot).sort()]) : "";

function Feedback({ notice }: { notice?: Notice }) {
  return notice ? <p className="ui-status settings-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p> : null;
}

export function ModuleSettings({ snapshot, onChanged, selection = false }: { snapshot?: ModulePlatformSnapshot; onChanged: () => void; selection?: boolean }) {
  const [stored, setStored] = useState(snapshot);
  const [draft, setDraft] = useState<string[]>(() => initialDraft(snapshot));
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [review, setReview] = useState<ModuleSnapshotItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const id = useId();
  const reviewPanel = useRef<HTMLElement>(null);
  const loadedKey = useRef(serverKey(snapshot));
  // Background refreshes replace the snapshot object; only a server-side change resets the draft and open review.
  useEffect(() => {
    setStored(snapshot);
    const key = serverKey(snapshot);
    if (key === loadedKey.current) return;
    const pending = review.length > 0 || Boolean(stored && !same(draft, enabledIds(stored)) && !same(draft, enabledIds(snapshot)));
    loadedKey.current = key; setDraft(initialDraft(snapshot)); setReview([]); setConfirmEmpty(false);
    if (pending && snapshot) setNotice({ tone: "error", text: "Module settings changed elsewhere. Your unsaved changes were cleared; review the current configuration before saving." });
  }, [snapshot]);
  useEffect(() => { if (review.length) window.requestAnimationFrame(() => reviewPanel.current?.focus()); }, [review.length]);
  const emptyPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (confirmEmpty) window.requestAnimationFrame(() => emptyPanel.current?.focus()); }, [confirmEmpty]);
  const invalid = Boolean(stored?.modules.some((module) => draft.includes(module.id) && module.dependencies.some((dependency) => !draft.includes(dependency))));
  const changed = Boolean(stored && (!stored.selectionCompleted || !same(draft, stored.modules.filter((module) => module.enabled).map((module) => module.id))));
  async function apply(confirm: ModuleSnapshotItem[] = []) {
    if (!stored || busy || invalid || !changed) return;
    setBusy(true); setNotice(undefined);
    try {
      await api("/admin/modules", { method: "PUT", body: JSON.stringify({ enabled: draft, revision: stored.revision, confirmDisable: confirm.map((module) => ({ moduleId: module.id, generation: module.generation })) }) });
      setNotice({ tone: "success", text: "Module configuration saved." });
      setReview([]);
      onChanged();
    } catch (error) { setNotice({ tone: "error", text: `${(error as Error).message} Reload the page before trying again.` }); }
    finally { setBusy(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!stored) return;
    const disabling = stored.modules.filter((module) => module.enabled && !draft.includes(module.id));
    if (disabling.length) setReview(disabling);
    else if (selection && !draft.length && !confirmEmpty) setConfirmEmpty(true);
    else void apply();
  }
  return <section className={selection ? "module-selection ui-card" : "module-controls"} aria-labelledby={`${id}-title`}>
    <div className="page-intro"><p className="kicker">{selection ? "First-time setup" : "Application structure"}</p><h1 id={`${id}-title`}>{selection ? "Choose modules" : "Modules"}</h1><p>Core always provides accounts, roster, labels, reports, branding, integrations, backups, updates, and module administration. Add the workflows this installation needs.</p></div>
    {selection && <div className="module-selection-intro"><p>Core always provides accounts, roster, labels, reports, branding, integrations, backups, and updates. Modules add workflows on top of Core.</p><p>Attendance is selected because most installations start with it. You can turn modules on or off later in Settings &gt; Modules.</p></div>}
    <Feedback notice={notice}/>
    {stored ? <form onSubmit={save}><fieldset disabled={busy}><legend>Optional modules</legend>{stored.modules.map((module) => <label className="module-choice module-setting-choice" key={module.id}><input type="checkbox" role="switch" aria-label={module.label} aria-describedby={`${id}-${module.id}-detail`} checked={draft.includes(module.id)} disabled={module.phase === "deleting" || module.unavailable && !draft.includes(module.id)} onChange={() => { setDraft((current) => toggle(current, module.id)); setReview([]); setConfirmEmpty(false); setNotice(undefined); }}/><span id={`${id}-${module.id}-detail`}><span className="module-choice-title"><strong>{module.label}</strong><span className="ui-status module-choice-badge" data-tone="neutral">{isFirstPartyModule(module.id) ? "Built-in" : "Plugin"}</span>{selection && recommendedModuleIds.includes(module.id) && <span className="ui-status module-choice-badge" data-tone="success">Recommended</span>}</span><small>{module.description}</small>{module.unavailable === "removed" && <small>Code is no longer installed. Disable it to delete its retained data.</small>}{module.unavailable === "setup-incomplete" && <small>Database setup has not completed. LancerLogin retries automatically.</small>}<small>{module.unavailable ? "" : module.enabled ? module.setup.ready ? "" : "Setup required" : module.phase === "deleting" ? "Deletion in progress - fresh setup will be required" : module.deletion.contentStillPresent ? `Disabled - data retained until ${new Date(module.deletion.deleteAfter!).toLocaleString()}` : module.phase === "deleted" ? "Disabled - retained data deleted" : "Disabled"}</small>{module.deletion.cleanupFailure && module.unavailable !== "setup-incomplete" && <small>Cleanup needs recovery attention and will retry.</small>}</span></label>)}</fieldset>
      {invalid && <p className="ui-status" data-tone="error" role="alert">Enable every required dependency for the selected modules.</p>}
      {review.length > 0 && <section ref={reviewPanel} className="settings-callout module-disable-review" role="region" tabIndex={-1} aria-labelledby={`${id}-review-title`}><div><h2 id={`${id}-review-title`}>Confirm module disable</h2><p>Access, device input, submissions, and scheduled work stop immediately. Module data is retained for 7 days before it becomes eligible for deletion.</p>{review.map((module) => <div key={module.id}><h3>{module.label}</h3><ul>{module.deletion.data.map((item) => <li key={item}>{item}</li>)}</ul></div>)}</div><div className="module-actions"><button className="primary-button" type="button" disabled={busy} onClick={() => void apply(review)}>Confirm disable</button><button type="button" disabled={busy} onClick={() => setReview([])}>Cancel</button></div></section>}
      {confirmEmpty && <section ref={emptyPanel} className="settings-callout module-empty-review" role="region" tabIndex={-1} aria-labelledby={`${id}-empty-title`}><div><h2 id={`${id}-empty-title`}>Continue without modules?</h2><p>Only Core features will be available: roster, labels, reports, branding, integrations, backups, and updates. Meetings, check-ins, and kiosks need the Attendance module. You can turn modules on later in Settings &gt; Modules.</p></div><div className="module-actions"><button className="primary-button" type="button" disabled={busy} onClick={() => void apply()}>Continue without modules</button><button type="button" disabled={busy} onClick={() => setConfirmEmpty(false)}>Choose modules</button></div></section>}
      <div className="module-actions"><button className="primary-button" type="submit" disabled={busy || invalid || !changed || review.length > 0 || confirmEmpty}>{busy ? "Saving..." : stored.modules.some((module) => module.enabled && !draft.includes(module.id)) ? "Review module disable" : selection ? "Continue" : "Save modules"}</button></div>
    </form> : <p className="ui-status" data-tone="error" role="alert">Module state is unavailable. Reload the page.</p>}
    {!selection && <><ModuleAccessGrants /><PluginManagement /></>}
  </section>;
}

export function ModuleAssignmentControls({ userId, name, role, active }: { userId: string; name: string; role: "admin" | "operator"; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<Assignments>();
  const [modules, setModules] = useState<ModuleSnapshotItem[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const id = useId();
  async function load() {
    setBusy(true); setNotice(undefined);
    try {
      const [assignments, snapshotValue] = await Promise.all([api<Assignments>(`/admin/modules/assignments/${encodeURIComponent(userId)}`), api<unknown>("/platform/modules")]);
      const snapshot = readModuleSnapshot(snapshotValue);
      setStored(assignments); setDraft(assignments.capabilities); setModules([...snapshot.modules]);
    } catch (error) { setNotice({ tone: "error", text: (error as Error).message }); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!stored || same(stored.capabilities, draft)) return;
    setBusy(true); setNotice(undefined);
    try {
      const next = await api<Assignments>(`/admin/modules/assignments/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify({ capabilities: draft, revision: stored.revision }) });
      setStored(next); setDraft(next.capabilities); setNotice({ tone: "success", text: "Module assignments saved." });
    } catch (error) { setNotice({ tone: "error", text: `${(error as Error).message} Reload assignments before trying again.` }); }
    finally { setBusy(false); }
  }
  if (role === "admin") return <p className="module-grants-summary">Admins can use every enabled module.</p>;
  if (!active) return <p className="module-grants-summary">Inactive Operators cannot use module workflows.</p>;
  const permissions = modules.flatMap((module) => module.permissions.filter((permission) => permission.operator).map((permission) => ({ module, permission })));
  return <div className="module-grants"><button type="button" className="quiet-button" aria-expanded={open} aria-controls={id} onClick={() => { setOpen((value) => !value); if (!open) void load(); }}>Module assignments for {name}</button>{open && <form id={id} className="module-controls" onSubmit={save}><p>Operators need an explicit assignment for each module. Core roster and account access remain available without a module assignment.</p><Feedback notice={notice}/>{permissions.map(({ module, permission }) => <label className="module-choice" key={permission.id}><input type="checkbox" checked={draft.includes(permission.id)} disabled={busy || module.phase === "deleting" || module.phase === "deleted"} onChange={() => setDraft((current) => toggle(current, permission.id))}/><span>{permission.label}<small>{module.enabled ? "Module enabled" : "Assignment retained while module is disabled"}</small></span></label>)}<div className="module-actions"><button className="primary-button" type="submit" disabled={busy || !stored || same(stored.capabilities, draft)}>Save assignments</button><button type="button" disabled={busy} onClick={() => void load()}>Reload</button></div></form>}</div>;
}
