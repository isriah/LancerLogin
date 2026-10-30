import { FormEvent, useEffect, useId, useRef, useState } from "react";
import { apiBaseUrl } from "./dashboard-api";
import { readDashboardReleaseState, type DashboardReleaseState } from "./dashboard-release";
import { useModalFocus } from "./modal-focus";
import { WebUpdateCard } from "./web-update-card";
import { diagnosticUrl, type WebUpdateResponse } from "./web-update";

type Phase = "disabled" | "enabled" | "retained" | "deleting" | "deleted" | null;
type Track = "stable" | "nightly";
type Pending = { kind: "add" | "upgrade" | "remove" | "revert"; id: string; source?: string; commit?: string; installedCommit?: string; version?: string | null; installedVersion?: string | null };
type LatestRelease = { tag: string; kind: "stable" | "beta" | "nightly"; commit: string | null };
export type PluginState = {
  releaseVersion: string; repository: string | null;
  credential: { state: "ready" | "missing" | "expired"; expiresAt: string | null };
  selection: { sha: string; present: boolean; officialModules: boolean; modules: Array<{ id: string; source: string; commit: string; track?: Track; phase: Phase }> } | null;
  installed: Array<{ id: string; source: string; commit: string; official: boolean; selected: boolean; phase: Phase; track?: Track; version?: string | null; latest?: LatestRelease | null; latestUnavailable?: boolean; updateAvailable?: boolean; releasePinVersion?: string | null }>;
  pending: Pending[];
  allowlist: { state: "none" | "configured" | "invalid" | "unknown"; sources?: string[] };
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
export class RequestError extends Error { constructor(message: string, readonly code?: string) { super(message); } }

/** GET, or POST a JSON body, with the session cookie; failures carry the Worker's message and stable code. */
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
  if (!response.ok) throw new RequestError(result.error ?? "The request could not be completed.", result.code);
  return result;
}
const short = (sha?: string | null) => sha ? sha.slice(0, 12) : "";
// A release version when the commit is a known release, otherwise the short commit.
const versionOr = (version: string | null | undefined, sha?: string | null) => version || short(sha);
const pendingText: Record<Pending["kind"], (change: Pending) => string> = {
  add: (change) => `Add ${change.id} at ${versionOr(change.version, change.commit)}`,
  upgrade: (change) => `Update ${change.id} from ${versionOr(change.installedVersion, change.installedCommit)} to ${versionOr(change.version, change.commit)}`,
  remove: (change) => `Remove ${change.id} (installed at ${versionOr(change.installedVersion, change.installedCommit)})`,
  revert: (change) => `Return ${change.id} to the version LancerLogin pins for this release`,
};
const trackLabel: Record<Track, string> = { stable: "Stable", nightly: "Nightly (testing only)" };
const latestTrackName: Record<Track, string> = { stable: "Stable", nightly: "Nightly" };
const nightlyWarning = "Nightly releases are testing builds. Use the Nightly track only on a test installation, never on one people depend on.";
/**
 * Fresh authentication for changes in Settings > Modules: the Admin's own password, or signing in with Google again. Either
 * lasts ten minutes. `onConfirm` posts the password and resolves true when the identity was confirmed.
 */
export function IdentityConfirmation({ options, freshUntil, busy, action, onConfirm }: { options: PluginState["reauthentication"]; freshUntil: number | null; busy: boolean; action: string; onConfirm: (password: string) => Promise<boolean> }) {
  const [password, setPassword] = useState("");
  if (freshUntil && freshUntil > Date.now()) return <p className="field-help" role="status">Identity confirmed until {new Date(freshUntil).toLocaleTimeString()}.</p>;
  return <div className="plugin-reauth"><p>Confirm your identity to {action}. Confirmation lasts ten minutes.</p>
    {options.password && <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void onConfirm(password).then((confirmed) => { if (confirmed) setPassword(""); }); }}><label>Your password<input className="ui-control" type="password" autoComplete="current-password" value={password} disabled={busy} required onChange={(event) => setPassword(event.target.value)} /></label><button className="ui-button" type="submit" disabled={busy || !password}>Confirm identity</button></form>}
    {options.google && <a className="ui-button" href={`${apiBaseUrl}/auth/google/start?reauth=modules`}>Sign in again with Google</a>}
    {!options.password && !options.google && <p className="ui-status" data-tone="error">Sign out and sign in again to confirm your identity.</p>}
  </div>;
}

const removalBlocked = (phase: Phase) => phase === "enabled" ? "Turn this module off and save before removing it." : phase === "retained" || phase === "deleting" ? "Its retained data must be deleted before the module can be removed." : "";

function ChangeDialog({ draft, state, onClose, onCommitted }: { draft: Draft; state: PluginState; onClose: () => void; onCommitted: (message: string) => void }) {
  const [form, setForm] = useState<Draft>({ ...draft, track: draft.track ?? "stable" });
  const [review, setReview] = useState<Review>();
  const [lookup, setLookup] = useState<{ busy: boolean; result?: ReleaseLookup; error?: string }>({ busy: false });
  const lookupRun = useRef(0);
  const [trusted, setTrusted] = useState(false);
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
  // Update offers the newest published, immutable release on the module's track; the Admin still reviews its commit.
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
  async function reauthenticate(password: string) {
    let confirmed = false;
    await run(async () => { const result = await request<{ freshUntil: number | null }>("/admin/plugins/reauthenticate", { password }); setFreshUntil(result.freshUntil); confirmed = true; });
    return confirmed;
  }
  async function commit() {
    if (!review) return;
    await run(async () => {
      await request("/admin/plugins/change", { ...body(form), selectionSha: review.selectionSha, ...(form.action === "remove" ? {} : { trustConfirmed: true }) });
      onCommitted(`${form.action === "add" ? "Added" : form.action === "upgrade" ? "Pinned" : "Removed"} ${form.id}${form.action !== "remove" && form.track === "nightly" ? " on the Nightly track (testing only)" : ""} in the private deployment repository. Select Apply changes to deploy it.`);
    });
  }
  const verb = form.action === "add" ? "Add module" : form.action === "upgrade" ? "Update module" : "Remove module";
  const offered = lookup.result?.release && lookup.result.track === form.track ? lookup.result.release : undefined;
  const lookupText = lookup.busy ? `Looking up the newest ${trackLabel[form.track ?? "stable"]} release…` : lookup.error ? lookup.error : !lookup.result || lookup.result.track !== form.track ? "" : offered ? `Newest ${trackLabel[lookup.result.track]} release: ${offered.tag}${offered.kind === "nightly" ? " (nightly testing build)" : offered.kind === "beta" ? " (beta)" : ""}, commit ${short(offered.commit)}. Its full commit is filled in below; review it before committing.` : lookup.result.reason ?? "";
  const compatibility = review?.metadata ? review.metadata.state === "compatible" ? "Compatible with this installation" : review.metadata.state === "incompatible" ? "Incompatible with this installation" : "Not determined here" : "";
  return <div className="dialog-backdrop"><section ref={dialog} className="ui-dialog plugin-change-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
    <div className="dialog-heading"><div><h2 id={`${id}-title`}>{verb}</h2><p>Changes are committed to lancerlogin.modules.json in the private deployment repository. Nothing is deployed until you select Apply changes in Settings &gt; Modules.</p></div><button type="button" className="ui-button" aria-label="Close module dialog" disabled={busy} onClick={onClose}>×</button></div>
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    {editing && <form className="ui-form plugin-change-form" onSubmit={(event) => void inspect(event)}>
      <label>Module ID<input className="ui-control" required value={form.id} readOnly={draft.action !== "add"} autoComplete="off" spellCheck={false} aria-describedby={`${id}-id-help`} data-modal-initial-focus={draft.action === "add" ? "" : undefined} onChange={(event) => setForm({ ...form, id: event.target.value })} /></label>
      <p id={`${id}-id-help`} className="field-help">The ID the repository declares for its module, for example carpool. A repository provides exactly one module.</p>
      <label>Git repository URL<input className="ui-control" required type="url" inputMode="url" value={form.source} autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repository.git" aria-describedby={`${id}-source-help`} onChange={(event) => setForm({ ...form, source: event.target.value })} /></label>
      <p id={`${id}-source-help`} className="field-help">An https URL ending in .git, without credentials.</p>
      <label>Release track<select className="ui-control ui-native-select" value={form.track} disabled={busy} aria-describedby={`${id}-track-help`} onChange={(event) => { const next = { ...form, track: event.target.value as Track }; setForm(next); if (canLookup) void findRelease(next); }}><option value="stable">{trackLabel.stable}</option><option value="nightly">{trackLabel.nightly}</option></select></label>
      <p id={`${id}-track-help`} className="field-help">Update offers the newest published, immutable release on this track. Stable offers stable releases only; Nightly also offers beta and nightly prereleases.</p>
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
        {review.metadata && <div><dt>Compatibility</dt><dd>{compatibility}{review.metadata.version ? `. Module version ${review.metadata.version}` : ""}{review.metadata.contract ? `, module contract ${review.metadata.contract}` : ""}{review.metadata.core ? `, supports LancerLogin ${review.metadata.core}` : ""}.{review.metadata.reason ? ` ${review.metadata.reason}` : ""}</dd></div>}
        {review.metadata && <div><dt>Tables</dt><dd>{review.metadata.tablePrefix ? `Tables named ${review.metadata.tablePrefix}*.` : "Not determined here."}{review.metadata.migrations ? ` ${review.metadata.migrations.length ? `Migrations: ${review.metadata.migrations.join(", ")}.` : "No migrations."}` : ""}{review.metadata.adoptedCoreMigrations ? ` Adopts ${review.metadata.adoptedCoreMigrations} historical LancerLogin migrations.` : ""}</dd></div>}
        {review.metadata && <div><dt>Routes, jobs and Discord commands</dt><dd>{review.declaredNote}</dd></div>}
      </dl>
      {review.track === "nightly" && <p className="ui-status plugin-nightly-warning" data-tone="warning">{nightlyWarning}</p>}
      {review.action === "remove" ? <p>{review.official ? "The installation returns to the commit LancerLogin pins for this module." : "The module's code is removed when the change is applied. It is already turned off with no retained data."}</p>
        : <><p className="settings-callout plugin-trust">{review.trustStatement}</p>
          <label className="module-choice"><input type="checkbox" className="ui-checkbox" checked={trusted} disabled={busy} onChange={(event) => setTrusted(event.target.checked)} /><span>I trust this source and reviewed this exact commit.</span></label></>}
      <IdentityConfirmation options={state.reauthentication} freshUntil={freshUntil} busy={busy} action="add, update or remove modules" onConfirm={reauthenticate} />
      <div className="module-actions">
        <button className={`ui-button ui-button--primary primary-button${review.action === "remove" ? " ui-button--danger" : ""}`} type="button" disabled={busy || !fresh || review.action !== "remove" && (!trusted || review.metadata?.state === "incompatible")} onClick={() => void commit()}>{busy ? "Committing…" : review.action === "remove" ? "Commit removal" : "Commit change"}</button>
        {draft.action !== "remove" && <button className="ui-button" type="button" disabled={busy} onClick={() => setReview(undefined)}>Edit</button>}
        <button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>}
  </section></div>;
}

type Row = { id: string; source: string; commit: string; official: boolean; selected: boolean; phase: Phase; track?: Track; version?: string | null; latest?: LatestRelease | null; latestUnavailable?: boolean; updateAvailable?: boolean; releasePinVersion?: string | null; notInstalled?: boolean };
/**
 * Settings > Modules: the modules this installation runs from git repositories, read from the private deployment repository.
 * Each repository supplies exactly one module, so Admins see modules only; the plugin names stay internal.
 */
export type ModulePackages = {
  state?: PluginState; release?: DashboardReleaseState; error: string; notice: string; draft?: Draft;
  ready: boolean; locked: boolean; updateActive: boolean;
  open: (draft: Draft) => void; close: () => void; committed: (message: string) => void; setUpdateActive: (active: boolean) => void;
};
export function useModulePackages(enabled: boolean): ModulePackages {
  const [state, setState] = useState<PluginState>();
  const [release, setRelease] = useState<DashboardReleaseState>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft>();
  const [updateActive, setUpdateActive] = useState(false);
  async function load() {
    try {
      const [value, releaseState] = await Promise.all([request<PluginState>("/admin/plugins"), readDashboardReleaseState().catch(() => undefined)]);
      setState(value); setRelease(releaseState); setError("");
    } catch (cause) { setError((cause as Error).message); }
  }
  useEffect(() => {
    if (!enabled) return;
    void load();
    if (new URLSearchParams(window.location.search).get("reauthenticated") === "1") setNotice("Identity confirmed. Make your module or module access change within ten minutes.");
  }, [enabled]);
  return {
    state, release, error, notice, draft, updateActive, setUpdateActive,
    ready: state?.credential.state === "ready" && Boolean(state.repository) && Boolean(state.selection) && !state.error,
    locked: Boolean(state?.activeUpdate) || updateActive,
    open: (next) => { setNotice(""); setDraft(next); },
    close: () => setDraft(undefined),
    committed: (message) => { setDraft(undefined); setNotice(message); void load(); },
  };
}

/** Every module from a git repository: installed ones, then ones committed to the selection but not deployed yet. */
export function moduleRepositoryRows(packages: ModulePackages): Row[] {
  const { state } = packages;
  if (!state) return [];
  return [...state.installed, ...(state.selection?.modules ?? []).filter((entry) => !state.installed.some((item) => item.id === entry.id)).map((entry) => ({ ...entry, official: false, selected: true, notInstalled: true }))];
}
const pendingFor = (packages: ModulePackages, id: string) => packages.state?.pending.find((change) => change.id === id);
/** Row attributes for a module from a git repository: its pending change, release track and version status. */
export function moduleRowAttributes(packages: ModulePackages, id: string): Record<string, string | undefined> {
  const row = moduleRepositoryRows(packages).find((item) => item.id === id);
  if (!row) return {};
  const entry = packages.state?.selection?.modules.find((item) => item.id === id);
  return { "data-pending": pendingFor(packages, id)?.kind, "data-track": entry ? entry.track ?? "stable" : undefined, "data-version-status": versionStatus(row) };
}
function versionStatus(row: Row) {
  return row.notInstalled || row.latestUnavailable !== false ? "unavailable" : row.updateAvailable ? "update" : row.version && row.latest ? "current" : "unknown";
}

/** The "Not deployed" badge for a module whose committed change is waiting for Apply changes. */
export function NotDeployedBadge({ packages, id }: { packages: ModulePackages; id: string }) {
  return pendingFor(packages, id) ? <span className="ui-status module-choice-badge module-pending-badge" data-tone="warning">Not deployed</span> : null;
}

/** Source, commit, version and track lines for a module from a git repository, shown inside its row. */
export function ModuleSourceDetails({ packages, id }: { packages: ModulePackages; id: string }) {
  const { state } = packages;
  const row = moduleRepositoryRows(packages).find((item) => item.id === id);
  if (!state || !row) return null;
  const entry = state.selection?.modules.find((item) => item.id === id);
  const track = entry?.track ?? "stable";
  // A track label only describes a selection entry that was read; unpinned included modules follow LancerLogin's pin, and without the selection the track is unknown.
  const trackText = entry ? (track === "stable" ? " · Stable track" : "") : row.official && state.selection ? " · Pinned by LancerLogin" : "";
  // Versions come from the module's published releases; when they cannot be read, the commit alone is shown.
  const status = versionStatus(row);
  const versionText = status === "unavailable" ? "" : `${row.version ?? "Unreleased commit"} · `;
  const latestText = status === "unavailable" ? "Latest version unavailable" : `Latest on ${latestTrackName[row.track ?? track]}: ${row.latest?.tag ?? "no published release"}`;
  const blocked = entry && !row.official ? removalBlocked(row.phase) : "";
  return <>
    <small className="module-source">{row.source}</small>
    <small>{versionText}Commit <code>{short(row.commit)}</code>{row.official ? " · Included with LancerLogin" : ""}{row.selected ? " · Pinned by this installation" : ""}{trackText}</small>
    {row.notInstalled ? <small>Added but not deployed yet. Apply changes to install it.</small> : <small className="plugin-version">{latestText}{status === "update" ? <> · <span className="plugin-version-status">Update available</span></> : status === "current" ? <> · <span className="plugin-version-status">Up to date</span></> : null}</small>}
    {row.releasePinVersion && <small>Included with LancerLogin {state.releaseVersion}: {row.releasePinVersion}</small>}
    {track === "nightly" && <span className="plugin-track-badge">Nightly track · testing only</span>}
    {blocked && <small>{blocked}</small>}
  </>;
}

/** Update and Remove for a module from a git repository. Both commit a change that Apply changes then deploys. */
export function ModuleRepositoryActions({ packages, id, label }: { packages: ModulePackages; id: string; label: string }) {
  const { state, ready, locked } = packages;
  const row = moduleRepositoryRows(packages).find((item) => item.id === id);
  if (!state || !row) return null;
  const entry = state.selection?.modules.find((item) => item.id === id);
  const track = entry?.track ?? "stable";
  const blocked = entry && !row.official ? removalBlocked(row.phase) : "";
  const update = !row.notInstalled && <button className={`ui-button${versionStatus(row) === "update" ? " ui-button--primary primary-button" : ""}`} type="button" disabled={!ready || locked} aria-label={`Update ${label}`} onClick={() => packages.open({ action: "upgrade", id, source: entry?.source ?? row.source, commit: "", track })}>Update</button>;
  const remove = entry && <button className="ui-button" type="button" disabled={!ready || locked || Boolean(blocked)} aria-label={row.notInstalled ? `Remove pending ${label}` : row.official ? `Use LancerLogin's pin for ${label}` : `Remove ${label}`} onClick={() => packages.open({ action: "remove", id, source: "", commit: "" })}>{row.official ? "Use LancerLogin's pin" : "Remove"}</button>;
  return update || remove ? <div className="module-actions module-row-actions">{update}{remove}</div> : null;
}

export function AddModuleButton({ packages }: { packages: ModulePackages }) {
  return <button className="ui-button ui-button--primary primary-button" type="button" disabled={!packages.ready || packages.locked} onClick={() => packages.open({ action: "add", id: "", source: "", commit: "" })}>Add module</button>;
}

/** Whether modules can be added, updated and removed from the dashboard, and the result of the last change. */
export function ModuleRepositoryStatus({ packages }: { packages: ModulePackages }) {
  const { state, error, notice, ready, locked } = packages;
  const credentialText = !state ? "" : state.credential.state === "missing" ? "Adding, updating and removing modules from the dashboard is not set up yet. Settings > Updates shows how to add the module selection credential." : state.credential.state === "expired" ? "The module selection credential (LANCERLOGIN_MODULE_SELECTION_TOKEN) has expired. Replace the production environment secret with a new token, then run the \"Refresh web update credential\" workflow." : !state.repository ? "The private deployment repository is not configured." : `Module changes are committed to ${state.repository}. ${state.credential.expiresAt ? `Credential valid until ${new Date(state.credential.expiresAt).toLocaleDateString()}.` : "The credential has no expiry."}`;
  if (!state && !error && !notice) return null;
  return <div className="module-repository-status">
    {notice && <p className="ui-status settings-notice" data-tone="success" role="status">{notice}</p>}
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    {state && <>
      <p className="ui-status" data-tone={ready || !state.error && state.credential.state === "missing" ? "neutral" : "warning"}>{state.error ? state.error.message : credentialText}</p>
      {state.allowlist.state === "configured" && <p className="field-help">Allowed module sources: {state.allowlist.sources!.join(", ")}.</p>}
      {state.allowlist.state === "invalid" && <p className="ui-status" data-tone="error">The module source allowlist in the private repository is invalid, so no module can be added or updated.</p>}
      {locked && <p className="ui-status" data-tone="warning" role="status">An update is in progress. Adding, updating and removing modules is locked until it finishes.</p>}
    </>}
  </div>;
}

/** Committed module changes waiting to be deployed, and Apply changes, which redeploys the installed release with them. */
export function PendingModuleChanges({ packages }: { packages: ModulePackages }) {
  const { state, release, ready, updateActive } = packages;
  const id = useId();
  if (!state) return null;
  // The selection credential is optional: without it the installation works and the selection is edited in the repository.
  const optionalCredentialText = "Reading and changing the module selection from the dashboard needs the optional module selection token, LANCERLOGIN_MODULE_SELECTION_TOKEN. Without it, installed modules keep working; edit lancerlogin.modules.json in the private deployment repository instead. See \"Module selection credential\" in docs/MODULE-PLUGINS.md.";
  const applying = state.activeUpdate?.mode === "modules" || updateActive;
  return <section className="plugin-pending" aria-labelledby={`${id}-pending-title`}>
    <h3 id={`${id}-pending-title`}>Pending changes{state.pending.length > 0 && <> <span className="plugin-pending-badge">Not deployed</span></>}</h3>
    {state.pending.length ? <><p className="field-help">Committed in the private deployment repository and waiting for Apply changes. Installed modules are unchanged until then.</p>
      <ul className="plugin-list">{state.pending.map((change) => <li key={`${change.kind}:${change.id}`} className="plugin-row" data-pending={change.kind}><div><strong>{pendingText[change.kind](change)}</strong>{change.source && <small>{change.source}</small>}</div></li>)}</ul></>
      : <p className="field-help">{state.selection ? "No pending changes. Installed modules match the committed selection." : state.credential.state === "missing" ? optionalCredentialText : "Pending changes are unavailable until the selection can be read."}</p>}
    {release && (state.selection || applying) && <WebUpdateCard mode="modules" current={release.worker || state.releaseVersion} served={release.served} running={release.running} converged={release.converged} reloadAvailable={false} available={ready && state.pending.length > 0 && !state.activeUpdate} workflowUrl={release.workflowUrl} onStatus={(status: WebUpdateResponse) => packages.setUpdateActive(Boolean(status.activeRequest && status.activeRequest.state !== "prepared"))} />}
  </section>;
}

export function ModuleChangeDialog({ packages }: { packages: ModulePackages }) {
  return packages.draft && packages.state ? <ChangeDialog draft={packages.draft} state={packages.state} onClose={packages.close} onCommitted={packages.committed} /> : null;
}

type RequiredMigration = { id: string; label: string; plugin: { source: string; commit: string } | null };
/**
 * Settings > Updates: a module that moved out of LancerLogin into its own repository, still in use and missing from the next
 * build. The Admin keeps it by adding it through the module change flow, or removes it by turning it off in Settings > Modules.
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
  return <section className="module-migration-notices" aria-label="Modules that moved into their own repositories">
    {notice && <p className="ui-status settings-notice" data-tone="success" role="status">{notice}</p>}
    {required.map((module) => <div key={module.id} className="settings-callout module-migration" role="group" aria-labelledby={`migration-${module.id}`}>
      <p id={`migration-${module.id}`}><strong>{module.label} is in use and is now a separate module.</strong></p>
      <p>{module.label} is now installed from its own repository, and updating without it would stop {module.label}. Keep it by adding the module, which carries its data and settings over unchanged, or remove it: turn it off in Settings &gt; Modules, where its data is retained for seven days.</p>
      {!ready && state && <p className="field-help">{state.credential.state !== "ready" ? "Adding a module from the dashboard needs the module selection credential, LANCERLOGIN_MODULE_SELECTION_TOKEN; Setup status below shows how to add it. You can instead add the module to lancerlogin.modules.json in the private deployment repository." : "Module changes are locked while a web update is in progress."}</p>}
      <div className="module-actions">
        <button className="ui-button ui-button--primary primary-button" type="button" disabled={!ready || !module.plugin} onClick={() => { setNotice(""); setDraft({ action: "add", id: module.id, source: module.plugin!.source, commit: module.plugin!.commit }); }}>Keep {module.label} (add module)</button>
        <a className="ui-button" href="/settings/modules">Remove {module.label}</a>
      </div>
    </div>)}
    {draft && state && <ChangeDialog draft={draft} state={state} onClose={() => setDraft(undefined)} onCommitted={() => { setDraft(undefined); setNotice(`Added the ${draft.id} module. The next update installs LancerLogin and the module together.`); void load(); }} />}
  </section>;
}
