import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { apiBaseUrl } from "./dashboard-api";
import { readDashboardReleaseState, type DashboardReleaseState } from "./dashboard-release";
import { useModalFocus } from "./modal-focus";
import { WebUpdateCard } from "./web-update-card";
import { diagnosticUrl, type WebUpdateResponse } from "./web-update";

type Phase = "disabled" | "enabled" | "retained" | "deleting" | "deleted" | null;
type Track = "stable" | "nightly";
type Pending = { kind: "add" | "upgrade" | "remove" | "revert"; id: string; source?: string; commit?: string; installedCommit?: string };
export type PluginState = {
  releaseVersion: string; repository: string | null;
  credential: { state: "ready" | "missing" | "expired"; expiresAt: string | null };
  selection: { sha: string; present: boolean; officialModules: boolean; modules: Array<{ id: string; source: string; commit: string; track?: Track; phase: Phase }> } | null;
  installed: Array<{ id: string; source: string; commit: string; official: boolean; selected: boolean; phase: Phase }>;
  pending: Pending[];
  allowlist: { state: "none" | "configured" | "invalid" | "unknown"; sources?: string[] };
  protection: { state: "configured" | "not_configured" | "unknown"; reviewers?: number };
  activeUpdate: { requestId: string; mode: string; state: string } | null;
  reauthentication: { freshUntil: number | null; password: boolean; google: boolean };
  error: { code: string; message: string } | null;
};
type Action = "add" | "upgrade" | "remove";
type Draft = { action: Action; id: string; source: string; commit: string; track?: Track };
type Review = {
  action: Action; id: string; source: string | null; commit: string | null; previousCommit: string | null; official: boolean; selectionSha: string; track?: Track | null; previousTrack?: Track | null;
  metadata: { state: "compatible" | "incompatible" | "unknown"; reason?: string; version?: string; contract?: number; core?: string; tablePrefix?: string; migrations?: string[]; adoptedCoreMigrations?: number } | null;
  declaredNote: string; trustStatement: string; allowlist: string;
};
type ReleaseLookup = { track: Track; release: { tag: string; kind: "stable" | "beta" | "nightly"; commit: string; url: string | null } | null; reason?: string };
class RequestError extends Error { constructor(message: string, readonly code?: string) { super(message); } }

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!response.ok) throw new RequestError(result.error ?? "The request could not be completed.", result.code);
  return result;
}
const short = (sha?: string | null) => sha ? sha.slice(0, 12) : "";
const pendingText: Record<Pending["kind"], (change: Pending) => string> = {
  add: (change) => `Add ${change.id} at ${short(change.commit)}`,
  upgrade: (change) => `Change ${change.id} from ${short(change.installedCommit)} to ${short(change.commit)}`,
  remove: (change) => `Remove ${change.id} (installed at ${short(change.installedCommit)})`,
  revert: (change) => `Return ${change.id} to the commit LancerLogin pins for this release`,
};
const trackLabel: Record<Track, string> = { stable: "Stable", nightly: "Nightly (testing only)" };
const nightlyWarning = "Nightly releases are testing builds. Use the Nightly track only on a test installation, never on one people depend on.";
const removalBlocked = (phase: Phase) => phase === "enabled" ? "Disable this module above before removing its plugin." : phase === "retained" || phase === "deleting" ? "Its retained data must be deleted before the plugin can be removed." : "";

function ChangeDialog({ draft, state, onClose, onCommitted }: { draft: Draft; state: PluginState; onClose: () => void; onCommitted: (message: string) => void }) {
  const [form, setForm] = useState<Draft>({ ...draft, track: draft.track ?? "stable" });
  const [review, setReview] = useState<Review>();
  const [lookup, setLookup] = useState<{ busy: boolean; result?: ReleaseLookup; error?: string }>({ busy: false });
  const lookupRun = useRef(0);
  const [trusted, setTrusted] = useState(false);
  const [password, setPassword] = useState("");
  const [freshUntil, setFreshUntil] = useState(state.reauthentication.freshUntil);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const id = useId();
  useModalFocus(dialog, true, busy, onClose);
  const fresh = Boolean(freshUntil && freshUntil > Date.now());
  const editing = draft.action !== "remove" && !review;
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError("");
    try { await operation(); } catch (cause) { setError((cause as Error).message); if ((cause as RequestError).code === "reauthentication_required") setFreshUntil(null); if ((cause as RequestError).code === "selection_changed") setReview(undefined); }
    finally { setBusy(false); }
  }
  const body = (value: Draft) => value.action === "remove" ? { action: value.action, id: value.id } : { action: value.action, id: value.id.trim(), source: value.source.trim(), commit: value.commit.trim().toLowerCase(), track: value.track ?? "stable" };
  // Upgrade offers the newest published, immutable release on the plugin's track; the Admin still reviews its commit.
  async function findRelease(value: Draft, replace = true) {
    const current = ++lookupRun.current;
    setLookup({ busy: true });
    try {
      const result = await request<ReleaseLookup>("/admin/plugins/release", { id: value.id.trim(), source: value.source.trim(), track: value.track ?? "stable" });
      if (current !== lookupRun.current) return;
      setLookup({ busy: false, result });
      if (result.release) setForm((latest) => latest.track === result.track && (replace || !latest.commit.trim()) ? { ...latest, commit: result.release!.commit } : latest);
    } catch (cause) { if (current === lookupRun.current) setLookup({ busy: false, error: (cause as Error).message }); }
  }
  const canLookup = Boolean(form.id.trim() && form.source.trim());
  async function inspect(event?: FormEvent) {
    event?.preventDefault();
    await run(async () => { setTrusted(false); setReview(await request<Review>("/admin/plugins/review", body(form))); });
  }
  useEffect(() => { if (draft.action === "remove") void inspect(); else if (draft.action === "upgrade" && canLookup) void findRelease(form, false); }, []);
  async function reauthenticate(event: FormEvent) {
    event.preventDefault();
    await run(async () => { const result = await request<{ freshUntil: number | null }>("/admin/plugins/reauthenticate", { password }); setPassword(""); setFreshUntil(result.freshUntil); });
  }
  async function commit() {
    if (!review) return;
    await run(async () => {
      await request("/admin/plugins/change", { ...body(form), selectionSha: review.selectionSha, ...(form.action === "remove" ? {} : { trustConfirmed: true }) });
      onCommitted(`${form.action === "add" ? "Added" : form.action === "upgrade" ? "Pinned" : "Removed"} ${form.id}${form.action !== "remove" && form.track === "nightly" ? " on the Nightly track (testing only)" : ""} in the private deployment repository. Apply plugin changes to deploy it.`);
    });
  }
  const verb = form.action === "add" ? "Add plugin" : form.action === "upgrade" ? "Upgrade plugin" : "Remove plugin";
  const offered = lookup.result?.release && lookup.result.track === form.track ? lookup.result.release : undefined;
  const lookupText = lookup.busy ? `Looking up the newest ${trackLabel[form.track ?? "stable"]} release…` : lookup.error ? lookup.error : !lookup.result || lookup.result.track !== form.track ? "" : offered ? `Newest ${trackLabel[lookup.result.track]} release: ${offered.tag}${offered.kind === "nightly" ? " (nightly testing build)" : offered.kind === "beta" ? " (beta)" : ""}, commit ${short(offered.commit)}. Its full commit is filled in below; review it before committing.` : lookup.result.reason ?? "";
  const compatibility = review?.metadata ? review.metadata.state === "compatible" ? "Compatible with this installation" : review.metadata.state === "incompatible" ? "Incompatible with this installation" : "Not determined here" : "";
  return <div className="dialog-backdrop"><section ref={dialog} className="ui-dialog plugin-change-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
    <div className="dialog-heading"><div><h2 id={`${id}-title`}>{verb}</h2><p>Changes are committed to lancerlogin.modules.json in the private deployment repository. Nothing is deployed until you apply plugin changes.</p></div><button type="button" className="ui-button" aria-label="Close plugin dialog" disabled={busy} onClick={onClose}>×</button></div>
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    {editing && <form className="ui-form plugin-change-form" onSubmit={(event) => void inspect(event)}>
      <label>Module ID<input className="ui-control" required value={form.id} readOnly={draft.action !== "add"} autoComplete="off" spellCheck={false} aria-describedby={`${id}-id-help`} data-modal-initial-focus={draft.action === "add" ? "" : undefined} onChange={(event) => setForm({ ...form, id: event.target.value })} /></label>
      <p id={`${id}-id-help`} className="field-help">The plugin's module ID, for example carpool.</p>
      <label>Git repository URL<input className="ui-control" required type="url" inputMode="url" value={form.source} autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repository.git" aria-describedby={`${id}-source-help`} onChange={(event) => setForm({ ...form, source: event.target.value })} /></label>
      <p id={`${id}-source-help`} className="field-help">An https URL ending in .git, without credentials.</p>
      <label>Release track<select className="ui-control ui-native-select" value={form.track} disabled={busy} aria-describedby={`${id}-track-help`} onChange={(event) => { const next = { ...form, track: event.target.value as Track }; setForm(next); if (canLookup) void findRelease(next); }}><option value="stable">{trackLabel.stable}</option><option value="nightly">{trackLabel.nightly}</option></select></label>
      <p id={`${id}-track-help`} className="field-help">Upgrade offers the newest published, immutable release on this track. Stable offers stable releases only; Nightly also offers beta and nightly prereleases.</p>
      {form.track === "nightly" && <p className="ui-status plugin-nightly-warning" data-tone="warning">{nightlyWarning}</p>}
      <div className="plugin-release-lookup"><button className="ui-button" type="button" disabled={busy || lookup.busy || !canLookup} onClick={() => void findRelease(form)}>Find newest release</button>
        <p className="field-help" role="status" aria-live="polite">{lookupText}{diagnosticUrl(offered?.url) && <> <a href={diagnosticUrl(offered?.url)} target="_blank" rel="noreferrer">Release notes</a></>}</p></div>
      <label>Commit SHA<input className="ui-control" required value={form.commit} autoComplete="off" spellCheck={false} pattern="[0-9a-fA-F]{40}" aria-describedby={`${id}-commit-help`} data-modal-initial-focus={draft.action === "upgrade" ? "" : undefined} onChange={(event) => setForm({ ...form, commit: event.target.value })} /></label>
      <p id={`${id}-commit-help`} className="field-help">The full 40-character commit you reviewed. Branches, tags and shortened SHAs are not accepted.</p>
      <div className="module-actions"><button className="ui-button ui-button--primary primary-button" type="submit" disabled={busy}>{busy ? "Checking…" : "Review change"}</button><button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>}
    {!review && !editing && !error && <p className="ui-status" role="status">Checking the change…</p>}
    {review && <div className="plugin-review" aria-labelledby={`${id}-review-title`} role="group">
      <h3 id={`${id}-review-title`}>Confirm {review.id}</h3>
      <dl className="plugin-review-details">
        <div><dt>Source</dt><dd>{review.source ?? "Unknown"}</dd></div>
        {review.commit && <div><dt>Commit</dt><dd><code>{review.commit}</code></dd></div>}
        {review.previousCommit && <div><dt>{review.action === "remove" ? "Selected commit" : "Previous commit"}</dt><dd><code>{review.previousCommit}</code></dd></div>}
        {review.track && <div><dt>Release track</dt><dd>{trackLabel[review.track]}{review.previousTrack && review.previousTrack !== review.track ? `, changed from ${trackLabel[review.previousTrack]}` : ""}{offered && offered.commit === review.commit ? `. Release ${offered.tag}` : ""}.</dd></div>}
        {review.metadata && <div><dt>Compatibility</dt><dd>{compatibility}{review.metadata.version ? `. Plugin version ${review.metadata.version}` : ""}{review.metadata.contract ? `, module contract ${review.metadata.contract}` : ""}{review.metadata.core ? `, supports LancerLogin ${review.metadata.core}` : ""}.{review.metadata.reason ? ` ${review.metadata.reason}` : ""}</dd></div>}
        {review.metadata && <div><dt>Tables</dt><dd>{review.metadata.tablePrefix ? `Tables named ${review.metadata.tablePrefix}*.` : "Not determined here."}{review.metadata.migrations ? ` ${review.metadata.migrations.length ? `Migrations: ${review.metadata.migrations.join(", ")}.` : "No migrations."}` : ""}{review.metadata.adoptedCoreMigrations ? ` Adopts ${review.metadata.adoptedCoreMigrations} historical LancerLogin migrations.` : ""}</dd></div>}
        {review.metadata && <div><dt>Routes, jobs and Discord commands</dt><dd>{review.declaredNote}</dd></div>}
      </dl>
      {review.track === "nightly" && <p className="ui-status plugin-nightly-warning" data-tone="warning">{nightlyWarning}</p>}
      {review.action === "remove" ? <p>{review.official ? "The installation returns to the commit LancerLogin pins for this module." : "The plugin's code is removed when the change is applied. Its module is already disabled with no retained data."}</p>
        : <><p className="settings-callout plugin-trust">{review.trustStatement}</p>
          <label className="module-choice"><input type="checkbox" className="ui-checkbox" checked={trusted} disabled={busy} onChange={(event) => setTrusted(event.target.checked)} /><span>I trust this source and reviewed this exact commit.</span></label></>}
      {fresh ? <p className="field-help" role="status">Identity confirmed until {new Date(freshUntil!).toLocaleTimeString()}.</p>
        : <div className="plugin-reauth"><p>Confirm your identity to change plugins. Confirmation lasts ten minutes.</p>
          {state.reauthentication.password && <form className="ui-form" onSubmit={(event) => void reauthenticate(event)}><label>Your password<input className="ui-control" type="password" autoComplete="current-password" value={password} disabled={busy} required onChange={(event) => setPassword(event.target.value)} /></label><button className="ui-button" type="submit" disabled={busy || !password}>Confirm identity</button></form>}
          {state.reauthentication.google && <a className="ui-button" href={`${apiBaseUrl}/auth/google/start?reauth=modules`}>Sign in again with Google</a>}
          {!state.reauthentication.password && !state.reauthentication.google && <p className="ui-status" data-tone="error">Sign out and sign in again to confirm your identity.</p>}
        </div>}
      <div className="module-actions">
        <button className={`ui-button ui-button--primary primary-button${review.action === "remove" ? " ui-button--danger" : ""}`} type="button" disabled={busy || !fresh || review.action !== "remove" && (!trusted || review.metadata?.state === "incompatible")} onClick={() => void commit()}>{busy ? "Committing…" : review.action === "remove" ? "Commit removal" : "Commit change"}</button>
        {draft.action !== "remove" && <button className="ui-button" type="button" disabled={busy} onClick={() => setReview(undefined)}>Edit</button>}
        <button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>}
  </section></div>;
}

export function PluginManagement() {
  const [state, setState] = useState<PluginState>();
  const [release, setRelease] = useState<DashboardReleaseState>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [updateActive, setUpdateActive] = useState(false);
  const id = useId();
  async function load() {
    try {
      const [value, releaseState] = await Promise.all([request<PluginState>("/admin/plugins"), readDashboardReleaseState().catch(() => undefined)]);
      setState(value); setRelease(releaseState); setError("");
    } catch (cause) { setError((cause as Error).message); }
  }
  useEffect(() => {
    void load();
    if (new URLSearchParams(window.location.search).get("reauthenticated") === "1") setNotice("Identity confirmed. Review and commit your plugin change within ten minutes.");
  }, []);
  const ready = state?.credential.state === "ready" && Boolean(state.repository) && Boolean(state.selection) && !state.error;
  const locked = Boolean(state?.activeUpdate) || updateActive;
  const selected = new Map(state?.selection?.modules.map((entry) => [entry.id, entry]) ?? []);
  const rows = state ? [...state.installed, ...(state.selection?.modules ?? []).filter((entry) => !state.installed.some((item) => item.id === entry.id)).map((entry) => ({ ...entry, official: false, selected: true, notInstalled: true }))] : [];
  // The selection credential is optional: without it the installation works and the selection is edited in the repository.
  const optionalCredentialText = "Reading and changing the plugin selection from the dashboard needs the optional module selection token, LANCERLOGIN_MODULE_SELECTION_TOKEN. Without it, installed plugins keep working; edit lancerlogin.modules.json in the private deployment repository instead. See \"Plugin selection credential\" in docs/MODULE-PLUGINS.md.";
  const credentialText = !state ? "" : state.credential.state === "missing" ? "Plugin management needs the plugin selection credential. Your installation operator provisions it in the private deployment repository." : state.credential.state === "expired" ? "The plugin selection credential has expired. Your installation operator must renew it." : !state.repository ? "The private deployment repository is not configured." : `Changes are committed to ${state.repository}. Credential valid until ${new Date(state.credential.expiresAt!).toLocaleDateString()}.`;
  const protectionText = state?.protection.state === "configured" ? `Production approval is required (${state.protection.reviewers} reviewer${state.protection.reviewers === 1 ? "" : "s"}). A plugin change cannot be deployed from this dashboard alone.` : state?.protection.state === "not_configured" ? "Production approval is not configured. We recommend required reviewers on the production environment, so a compromised Admin session cannot deploy plugin code by itself." : "Production approval could not be checked (unknown). We recommend required reviewers on the production environment of the private deployment repository.";
  return <section className="module-controls plugin-management" aria-labelledby={`${id}-title`}>
    <div className="panel-heading"><div><h2 id={`${id}-title`}>Plugins</h2><p>Plugins add modules from a git repository pinned to an exact commit. They run with the same access as LancerLogin.</p></div>
      <button className="ui-button ui-button--primary primary-button" type="button" disabled={!ready || locked} onClick={() => { setNotice(""); setDraft({ action: "add", id: "", source: "", commit: "" }); }}>Add plugin</button></div>
    {notice && <p className="ui-status settings-notice" data-tone="success" role="status">{notice}</p>}
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    {state && <>
      <p className="ui-status" data-tone={ready || !state.error && state.credential.state === "missing" ? "neutral" : "warning"}>{state.error ? state.error.message : credentialText}</p>
      <p className="ui-status plugin-protection" data-tone={state.protection.state === "configured" ? "success" : "warning"}>{protectionText}</p>
      {state.allowlist.state === "configured" && <p className="field-help">Allowed plugin sources: {state.allowlist.sources!.join(", ")}.</p>}
      {state.allowlist.state === "invalid" && <p className="ui-status" data-tone="error">The plugin source allowlist in the private repository is invalid, so no plugin can be added or upgraded.</p>}
      {locked && <p className="ui-status" data-tone="warning" role="status">A web update is in progress. Plugin changes are locked until it finishes.</p>}
      <h3>Installed plugins</h3>
      {rows.filter((row) => !("notInstalled" in row)).length === 0 && <p className="field-help">No plugins are installed.</p>}
      <ul className="plugin-list">{rows.filter((row) => !("notInstalled" in row)).map((row) => {
        const entry = selected.get(row.id); const blocked = entry && !row.official ? removalBlocked(row.phase) : "";
        const track = entry?.track ?? "stable";
        // A track label only describes a selection entry that was read; unpinned official plugins follow LancerLogin's pin, and without the selection the track is unknown.
        const trackLabel = entry ? (track === "stable" ? " · Stable track" : "") : row.official && state.selection ? " · Pinned by LancerLogin" : "";
        return <li key={row.id} className="plugin-row" data-track={entry ? track : undefined}><div><strong>{row.id}</strong><small>{row.source}</small><small>Commit <code>{short(row.commit)}</code>{row.official ? " · Included with LancerLogin" : ""}{row.selected ? " · Pinned by this installation" : ""}{trackLabel}</small>{track === "nightly" && <span className="plugin-track-badge">Nightly track · testing only</span>}{blocked && <small>{blocked}</small>}</div>
          <div className="module-actions"><button className="ui-button" type="button" disabled={!ready || locked} aria-label={`Upgrade ${row.id}`} onClick={() => { setNotice(""); setDraft({ action: "upgrade", id: row.id, source: entry?.source ?? row.source, commit: "", track }); }}>Upgrade</button>
            {entry && <button className="ui-button" type="button" disabled={!ready || locked || Boolean(blocked)} aria-label={row.official ? `Use LancerLogin's pin for ${row.id}` : `Remove ${row.id}`} onClick={() => { setNotice(""); setDraft({ action: "remove", id: row.id, source: "", commit: "" }); }}>{row.official ? "Use LancerLogin's pin" : "Remove"}</button>}</div></li>;
      })}</ul>
      <section className="plugin-pending" aria-labelledby={`${id}-pending-title`}>
        <h3 id={`${id}-pending-title`}>Pending changes{state.pending.length > 0 && <> <span className="plugin-pending-badge">Not deployed</span></>}</h3>
        {state.pending.length ? <><p className="field-help">Committed in the private deployment repository and waiting to be applied. Installed modules are unchanged until then.</p>
          <ul className="plugin-list">{state.pending.map((change) => {
            const entry = selected.get(change.id); const installed = state.installed.find((item) => item.id === change.id);
            const blocked = change.kind === "add" && entry ? removalBlocked(entry.phase) : "";
            return <li key={`${change.kind}:${change.id}`} className="plugin-row" data-pending={change.kind}><div><strong>{pendingText[change.kind](change)}</strong>{change.source && <small>{change.source}</small>}</div>
              {change.kind === "add" && entry && !installed && <div className="module-actions"><button className="ui-button" type="button" disabled={!ready || locked || Boolean(blocked)} aria-label={`Remove pending ${change.id}`} onClick={() => setDraft({ action: "remove", id: change.id, source: "", commit: "" })}>Remove</button></div>}</li>;
          })}</ul></> : <p className="field-help">{state.selection ? "No pending changes. Installed plugins match the committed selection." : state.credential.state === "missing" ? optionalCredentialText : "Pending changes are unavailable until the selection can be read."}</p>}
      </section>
      {release && (state.pending.length > 0 || state.activeUpdate?.mode === "modules" || updateActive) && <WebUpdateCard mode="modules" current={release.worker || state.releaseVersion} served={release.served} running={release.running} converged={release.converged} reloadAvailable={false} available={state.pending.length > 0 && !state.activeUpdate} workflowUrl={release.workflowUrl} onStatus={(status: WebUpdateResponse) => setUpdateActive(Boolean(status.activeRequest && status.activeRequest.state !== "prepared"))} />}
    </>}
    {draft && state && <ChangeDialog draft={draft} state={state} onClose={() => setDraft(undefined)} onCommitted={(message) => { setDraft(undefined); setNotice(message); void load(); }} />}
  </section>;
}

type RequiredMigration = { id: string; label: string; plugin: { source: string; commit: string } | null };
/**
 * Settings > Updates: a module that moved out of LancerLogin into a plugin, still in use and missing from the next build.
 * The Admin keeps it by adding its plugin through the plugin change flow, or removes it by disabling it in Settings > Modules.
 */
export function ModuleMigrationNotice({ onRequired }: { onRequired?: (required: boolean) => void }) {
  const [required, setRequired] = useState<RequiredMigration[]>([]);
  const [state, setState] = useState<PluginState>();
  const [draft, setDraft] = useState<Draft>();
  const [notice, setNotice] = useState("");
  async function load() {
    try {
      const result = await request<{ required: RequiredMigration[] }>("/admin/plugins/migrations");
      setRequired(result.required); onRequired?.(result.required.length > 0);
      if (result.required.length) setState(await request<PluginState>("/admin/plugins").catch(() => undefined));
    } catch { setRequired([]); onRequired?.(false); }
  }
  useEffect(() => { void load(); }, []);
  if (!required.length && !notice) return null;
  const ready = state?.credential.state === "ready" && Boolean(state.selection) && !state.activeUpdate;
  return <section className="module-migration-notices" aria-label="Modules that moved into plugins">
    {notice && <p className="ui-status settings-notice" data-tone="success" role="status">{notice}</p>}
    {required.map((module) => <div key={module.id} className="settings-callout module-migration" role="group" aria-labelledby={`migration-${module.id}`}>
      <p id={`migration-${module.id}`}><strong>{module.label} is in use and is now a separate plugin.</strong></p>
      <p>Updating without its plugin would stop {module.label}. Keep it by adding the plugin, which carries its data and settings over unchanged, or remove it: disable it in Settings &gt; Modules, where its data is retained for seven days.</p>
      {!ready && state && <p className="field-help">{state.credential.state !== "ready" ? "Adding a plugin from the dashboard needs the plugin selection credential. Your installation operator can add the plugin to lancerlogin.modules.json instead." : "Plugin changes are locked while a web update is in progress."}</p>}
      <div className="module-actions">
        <button className="ui-button ui-button--primary primary-button" type="button" disabled={!ready || !module.plugin} onClick={() => { setNotice(""); setDraft({ action: "add", id: module.id, source: module.plugin!.source, commit: module.plugin!.commit }); }}>Keep {module.label} (add plugin)</button>
        <a className="ui-button" href="/settings/modules">Remove {module.label}</a>
      </div>
    </div>)}
    {draft && state && <ChangeDialog draft={draft} state={state} onClose={() => setDraft(undefined)} onCommitted={() => { setDraft(undefined); setNotice(`Added the ${draft.id} plugin. The next update installs LancerLogin and the plugin together.`); void load(); }} />}
  </section>;
}
