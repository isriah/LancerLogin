import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { isFirstPartyModule, recommendedModuleIds, type ModulePlatformSnapshot, type ModuleSnapshotItem } from "../../../packages/shared/src/module-platform.ts";
import { api } from "./dashboard-api";
import { ModuleAccessGrants } from "./module-access-grants";
import { AddModuleButton, ModuleChangeDialog, ModuleRepositoryActions, ModuleRepositoryStatus, ModuleSourceDetails, NotDeployedBadge, PendingModuleChanges, moduleRepositoryRows, moduleRowAttributes, useModulePackages, type ModulePackages } from "./plugin-management";

type Notice = { tone: "success" | "error"; text: string };
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value) => right.includes(value));
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
const enabledIds = (snapshot?: ModulePlatformSnapshot) => snapshot?.modules.filter((module) => module.enabled).map((module) => module.id) ?? [];
// A fresh installation starts with the recommended modules selected; after that the saved selection is the draft.
const initialDraft = (snapshot?: ModulePlatformSnapshot) => snapshot && !snapshot.selectionCompleted ? snapshot.modules.filter((module) => module.enabled || recommendedModuleIds.includes(module.id) && !module.unavailable && module.phase !== "deleting").map((module) => module.id) : enabledIds(snapshot);
const serverKey = (snapshot?: ModulePlatformSnapshot) => snapshot ? JSON.stringify([snapshot.revision, snapshot.selectionCompleted, enabledIds(snapshot).sort()]) : "";

function Feedback({ notice }: { notice?: Notice }) {
  return notice ? <p className="ui-status settings-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p> : null;
}
/** Where a module comes from: built into LancerLogin, or a git repository pinned to a commit (shown in its row details). */
const sourceLabel = (moduleId: string) => isFirstPartyModule(moduleId) ? "Built-in" : "Git repository";
const instantText = "Turning a module on or off takes effect as soon as you save, with no deploy. Adding, updating or removing a module is committed first and takes effect when you select Apply changes.";

/** A module from a git repository that this dashboard build does not list (for example, committed and not deployed yet), so it has no switch. */
function RepositoryOnlyModuleRow({ packages, id }: { packages: ModulePackages; id: string }) {
  return <div className="module-row" data-module={id} {...moduleRowAttributes(packages, id)}>
    <div className="module-choice module-setting-choice module-static-choice"><span><span className="module-choice-title"><strong>{id}</strong><span className="ui-status module-choice-badge" data-tone="neutral">{sourceLabel(id)}</span><NotDeployedBadge packages={packages} id={id}/></span><ModuleSourceDetails packages={packages} id={id}/></span></div>
    <ModuleRepositoryActions packages={packages} id={id} label={id}/>
  </div>;
}

export function ModuleSettings({ snapshot, onChanged, selection = false }: { snapshot?: ModulePlatformSnapshot; onChanged: () => void; selection?: boolean }) {
  const [stored, setStored] = useState(snapshot);
  const [draft, setDraft] = useState<string[]>(() => initialDraft(snapshot));
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [review, setReview] = useState<ModuleSnapshotItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const id = useId();
  // Settings > Modules also lists where each module comes from and its committed changes; first-run selection does not.
  const packages = useModulePackages(!selection);
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
  const choice = (module: ModuleSnapshotItem) => <label className="module-choice module-setting-choice" key={module.id}><input type="checkbox" role="switch" aria-label={module.label} aria-describedby={`${id}-${module.id}-detail`} checked={draft.includes(module.id)} disabled={module.phase === "deleting" || module.unavailable && !draft.includes(module.id)} onChange={() => { setDraft((current) => toggle(current, module.id)); setReview([]); setConfirmEmpty(false); setNotice(undefined); }}/><span id={`${id}-${module.id}-detail`}><span className="module-choice-title"><strong>{module.label}</strong><span className="ui-status module-choice-badge" data-tone="neutral">{sourceLabel(module.id)}</span>{!selection && <NotDeployedBadge packages={packages} id={module.id}/>}{selection && recommendedModuleIds.includes(module.id) && <span className="ui-status module-choice-badge" data-tone="success">Recommended</span>}</span><small>{module.description}</small>{!selection && <ModuleSourceDetails packages={packages} id={module.id}/>}{module.unavailable === "removed" && <small>Code is no longer installed. Disable it to delete its retained data.</small>}{module.unavailable === "setup-incomplete" && <small>Database setup has not completed. LancerLogin retries automatically.</small>}<small>{module.unavailable ? "" : module.enabled ? !draft.includes(module.id) ? "Turns off when you save" : module.setup.ready ? "" : "Setup required" : draft.includes(module.id) ? selection ? "Turns on when you continue" : "Turns on when you save" : module.phase === "deleting" ? "Deletion in progress - fresh setup will be required" : module.deletion.contentStillPresent ? `Disabled - data retained until ${new Date(module.deletion.deleteAfter!).toLocaleString()}` : module.phase === "deleted" ? "Disabled - retained data deleted" : "Disabled"}</small>{module.deletion.cleanupFailure && module.unavailable !== "setup-incomplete" && <small>Cleanup needs recovery attention and will retry.</small>}</span></label>;
  // Modules from a git repository that this build does not list, such as one committed and waiting for Apply changes.
  const undeployed = selection || !stored ? [] : moduleRepositoryRows(packages).filter((row) => !stored.modules.some((module) => module.id === row.id)).map((row) => row.id);
  return <section className={selection ? "module-selection ui-card" : "module-controls"} aria-labelledby={`${id}-title`}>
    <div className="page-intro"><p className="kicker">{selection ? "First-time setup" : "Application structure"}</p><h1 id={`${id}-title`}>{selection ? "Choose modules" : "Modules"}</h1><p>Core always provides accounts, roster, labels, reports, branding, integrations, backups, updates, and module administration. Add the workflows this installation needs.</p></div>
    {selection && <div className="module-selection-intro"><p>Core always provides accounts, roster, labels, reports, branding, integrations, backups, and updates. Modules add workflows on top of Core.</p><p>Attendance is selected because most installations start with it. You can turn modules on or off later in Settings &gt; Modules.</p></div>}
    <Feedback notice={notice}/>
    {stored ? <form className={selection ? undefined : "module-card"} onSubmit={save}><fieldset disabled={busy}><legend>{selection ? "Optional modules" : "Modules"}</legend>
        {!selection && <div className="module-card-tools"><p className="field-help module-instant-help">{instantText}</p><AddModuleButton packages={packages}/></div>}
        {!selection && <ModuleRepositoryStatus packages={packages}/>}
        {selection ? stored.modules.map(choice) : <>{stored.modules.map((module) => <div className="module-row" key={module.id} data-module={module.id} {...moduleRowAttributes(packages, module.id)}>{choice(module)}<ModuleRepositoryActions packages={packages} id={module.id} label={module.label}/></div>)}{undeployed.map((moduleId) => <RepositoryOnlyModuleRow key={moduleId} packages={packages} id={moduleId}/>)}</>}
      </fieldset>
      {invalid && <p className="ui-status" data-tone="error" role="alert">Enable every required dependency for the selected modules.</p>}
      {review.length > 0 && <section ref={reviewPanel} className="settings-callout module-disable-review" role="region" tabIndex={-1} aria-labelledby={`${id}-review-title`}><div><h2 id={`${id}-review-title`}>Confirm module disable</h2><p>Access, device input, submissions, and scheduled work stop immediately. Module data is retained for 7 days before it becomes eligible for deletion.</p>{review.map((module) => <div key={module.id}><h3>{module.label}</h3><ul>{module.deletion.data.map((item) => <li key={item}>{item}</li>)}</ul></div>)}</div><div className="module-actions"><button className="primary-button" type="button" disabled={busy} onClick={() => void apply(review)}>Confirm disable</button><button type="button" disabled={busy} onClick={() => setReview([])}>Cancel</button></div></section>}
      {confirmEmpty && <section ref={emptyPanel} className="settings-callout module-empty-review" role="region" tabIndex={-1} aria-labelledby={`${id}-empty-title`}><div><h2 id={`${id}-empty-title`}>Continue without modules?</h2><p>Only Core features will be available: roster, labels, reports, branding, integrations, backups, and updates. Meetings, check-ins, and kiosks need the Attendance module. You can turn modules on later in Settings &gt; Modules.</p></div><div className="module-actions"><button className="primary-button" type="button" disabled={busy} onClick={() => void apply()}>Continue without modules</button><button type="button" disabled={busy} onClick={() => setConfirmEmpty(false)}>Choose modules</button></div></section>}
      <div className="module-actions"><button className="primary-button" type="submit" disabled={busy || invalid || !changed || review.length > 0 || confirmEmpty}>{busy ? "Saving..." : stored.modules.some((module) => module.enabled && !draft.includes(module.id)) ? "Review module disable" : selection ? "Continue" : "Save modules"}</button></div>
      {!selection && <PendingModuleChanges packages={packages}/>}
    </form> : <p className="ui-status" data-tone="error" role="alert">Module state is unavailable. Reload the page.</p>}
    {!selection && <><ModuleAccessGrants /><ModuleChangeDialog packages={packages}/></>}
  </section>;
}
