/**
 * Dashboard plugin management. Admins add, upgrade and remove plugins in Settings > Modules; the Worker commits each change
 * to lancerlogin.modules.json in the installation's private deployment repository, which stays the single source of truth.
 *
 * This deliberately lets the browser choose deployable plugin code, and nothing else: the Core release, workflow, ref,
 * slug and resources stay fixed. The selection credential is a separate fine-grained token with Contents write on the
 * private repository only. It is sent only to the fixed api.github.com origin, never returned, logged or stored in D1.
 * Plugin metadata for the confirmation is read anonymously, so no credential reaches a plugin's repository.
 */
import { WebUpdateError, absentSelectionSha, startedUpdate, type WebUpdateEnv } from "./web-updates.ts";
import { firstPartyModules } from "../../../packages/shared/src/module-platform.ts";
import { supportedModuleContractVersions } from "../../../packages/shared/src/module-contract.ts";
import { allowlistFileName, entryTrack, parseAllowlist, sourceAllowed, type AllowedSource, type Allowlist, parseModuleSource, parseSelectionFile, satisfiesCoreRange, selectionFileName, selectionTracks, serializeSelection, SelectionError, moduleIdPattern, commitPattern, type SelectionDocument, type SelectionEntry, type SelectionTrack } from "../../../packages/shared/src/module-selection.ts";
import { newestPluginRelease, parseReleaseVersion, pluginReleaseKind } from "../../../packages/shared/src/release-policy.mjs";
import { externalModuleSources } from "./generated/external-module-data.ts";
import { extractedModulesInUse } from "./extracted-modules.ts";
import { knownModule } from "./known-modules.ts";
import { credentialStatus, credentialUsable, observeCredentialResponse } from "./github-credential.ts";

export interface PluginSelectionEnv extends WebUpdateEnv { MODULE_SELECTION_TOKEN?: string; MODULE_SELECTION_TOKEN_EXPIRES_AT?: string }
export type InstalledPlugins = Readonly<Record<string, { readonly source: string; readonly commit: string; readonly official?: boolean; readonly selected?: boolean }>>;
type Principal = { userId: string; expiresAt: number; authenticatedAt?: number };

// The Worker writes only lancerlogin.modules.json. The source allowlist lives beside it and is never written by the Worker;
// its rules are shared with composition, which enforces the same file at build time.
export { allowlistFileName, parseAllowlist, sourceAllowed, type AllowedSource, type Allowlist };
export const selectionBranch = "main";
/** A change needs a sign-in or re-authentication within this window. */
export const reauthenticationWindowMs = 10 * 60_000;
export const trustStatement = "A plugin runs inside this installation's Worker and dashboard with the same access as LancerLogin: it can read and change all installation data and make network requests. LancerLogin does not review external plugins. Add only plugins whose source you trust, pinned to a commit you have reviewed.";
export const undeclaredNote = "Routes, jobs and Discord commands are declared in plugin code. LancerLogin does not run plugin code to show them here; composition checks them for conflicts before the change is applied, and refuses the change if any conflict.";

function fail(status: number, code: string, message: string): never { throw new WebUpdateError(status, code, message); }
const githubHeaders = (token?: string, accept = "application/vnd.github+json") => {
  const headers = new Headers({ accept, "user-agent": "LancerLogin", "x-github-api-version": "2026-03-10" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
};
function repository(env: PluginSelectionEnv): string {
  if (!env.UPDATE_REPOSITORY || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.UPDATE_REPOSITORY) || env.UPDATE_REPOSITORY.toLowerCase() === "isriah/lancerlogin") fail(503, "not_configured", "The private deployment repository is not configured.");
  return env.UPDATE_REPOSITORY;
}
export type CredentialState = "ready" | "missing" | "expired";
/** Usability of the optional selection credential. A token without an expiry stays ready; expiresAt is then null. */
export function selectionCredentialState(env: PluginSelectionEnv): { state: CredentialState; expiresAt: string | null } {
  const { state, expiresAt } = credentialStatus("selection", env.MODULE_SELECTION_TOKEN, env.MODULE_SELECTION_TOKEN_EXPIRES_AT);
  // A rejected or soon-expiring token is still tried, so GitHub's own answer is reported.
  return { state: state === "missing" || state === "expired" ? state : "ready", expiresAt };
}
function selectionToken(env: PluginSelectionEnv): string {
  const { state } = selectionCredentialState(env);
  if (state === "missing") fail(503, "selection_credential_required", "Plugin management from the dashboard is not set up. Store a GitHub token as the production environment secret LANCERLOGIN_MODULE_SELECTION_TOKEN, then run the Refresh web update credential workflow.");
  if (state === "expired") fail(503, "selection_credential_expired", "The plugin selection credential has expired. Renew LANCERLOGIN_MODULE_SELECTION_TOKEN, then run the Refresh web update credential workflow.");
  return env.MODULE_SELECTION_TOKEN!;
}

/** Requests carrying the selection credential: fixed origin, no redirects, bounded time, sanitized failures. */
async function privateGitHub(env: PluginSelectionEnv, path: string, init: RequestInit = {}): Promise<Response> {
  const token = selectionToken(env);
  const headers = githubHeaders(token);
  if (init.body) headers.set("content-type", "application/json");
  let result: Response;
  try { result = await fetch(`https://api.github.com${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) }); }
  catch { return fail(503, "provider_unavailable", "GitHub is unavailable. No change was made."); }
  observeCredentialResponse("selection", token, result);
  if (result.status >= 300 && result.status < 400) fail(503, "provider_unavailable", "GitHub returned an unexpected redirect. The request was not forwarded.");
  if (result.status === 401) fail(503, "selection_credential_rejected", "GitHub rejected the plugin selection credential. Replace LANCERLOGIN_MODULE_SELECTION_TOKEN, then run the Refresh web update credential workflow.");
  if (result.status === 429 || result.status === 403 && (result.headers.get("x-ratelimit-remaining") === "0" || result.headers.has("retry-after"))) fail(429, "cooldown", "GitHub requires a cooldown. Try again later.");
  if (result.status === 403) fail(503, "selection_credential_permission", "The plugin selection credential is missing Contents access to the private deployment repository.");
  return result;
}
function decodeBase64Text(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
function encodeBase64Text(value: string): string {
  const bytes = new TextEncoder().encode(value); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function readRepositoryFile(env: PluginSelectionEnv, name: string): Promise<{ sha: string; text: string } | null> {
  const response = await privateGitHub(env, `/repos/${repository(env)}/contents/${name}?ref=${selectionBranch}`);
  if (response.status === 404) return null;
  if (!response.ok) fail(503, "provider_unavailable", "GitHub could not read the private deployment repository.");
  const file = await response.json() as { type?: string; sha?: string; content?: string; encoding?: string; size?: number };
  if (file.type !== "file" || !file.sha || !commitPattern.test(file.sha) || file.encoding !== "base64" || typeof file.content !== "string" || (file.size ?? 0) > 65_536) fail(503, "selection_invalid", `${name} in the private deployment repository is not a readable file.`);
  try { return { sha: file.sha, text: decodeBase64Text(file.content) }; }
  catch { return fail(503, "selection_invalid", `${name} is not valid UTF-8 text.`); }
}
async function requirePrivateRepository(env: PluginSelectionEnv): Promise<void> {
  const response = await privateGitHub(env, `/repos/${repository(env)}`);
  if (response.status === 404) fail(503, "selection_credential_permission", "The plugin selection credential cannot access the private deployment repository.");
  if (!response.ok || (await response.json() as { private?: boolean }).private !== true) fail(503, "not_private", "Plugin management requires the configured private deployment repository.");
}

export type SelectionSnapshot = { sha: string; present: boolean; document: SelectionDocument };
/** The committed selection on main. A missing file is an empty selection that composes the official modules. */
export async function readSelection(env: PluginSelectionEnv): Promise<SelectionSnapshot> {
  await requirePrivateRepository(env);
  const file = await readRepositoryFile(env, selectionFileName);
  if (!file) return { sha: absentSelectionSha, present: false, document: { modules: [] } };
  try { return { sha: file.sha, present: true, document: parseSelectionFile(file.text) }; }
  catch (error) { if (error instanceof SelectionError) fail(503, "selection_invalid", `${selectionFileName} is invalid: ${error.message}. Repair it in the private deployment repository.`); throw error; }
}
/** For web update preparation: the selection's blob SHA, or undefined when the installation has no selection credential. */
export async function currentSelectionSha(env: PluginSelectionEnv): Promise<string | undefined> {
  if (selectionCredentialState(env).state === "missing") return undefined;
  return (await readSelection(env)).sha;
}

async function readAllowlist(env: PluginSelectionEnv): Promise<Allowlist> {
  const file = await readRepositoryFile(env, allowlistFileName).catch((error) => {
    if (error instanceof WebUpdateError && error.code === "selection_invalid") return { sha: "", text: "" };
    throw error;
  });
  return file ? parseAllowlist(file.text) : { state: "none" };
}

export type Protection = { state: "configured" | "not_configured" | "unknown"; reviewers?: number };
/** Required reviewers on the production environment, read with whichever available credential GitHub accepts. */
export async function readProductionProtection(env: PluginSelectionEnv): Promise<Protection> {
  let repo: string;
  try { repo = repository(env); } catch { return { state: "unknown" }; }
  const tokens = [selectionCredentialState(env).state === "ready" ? env.MODULE_SELECTION_TOKEN : undefined, credentialUsable("dispatch", env.WEB_UPDATE_TOKEN, env.WEB_UPDATE_TOKEN_EXPIRES_AT) ? env.WEB_UPDATE_TOKEN : undefined].filter((token): token is string => Boolean(token));
  for (const token of tokens) {
    let response: Response;
    try { response = await fetch(`https://api.github.com/repos/${repo}/environments/production`, { headers: githubHeaders(token), redirect: "manual", signal: AbortSignal.timeout(4_000) }); }
    catch { return { state: "unknown" }; }
    if (!response.ok) continue;
    const environment = await response.json().catch(() => undefined) as { protection_rules?: Array<{ type?: string; reviewers?: unknown[] }> } | undefined;
    if (!environment || !Array.isArray(environment.protection_rules)) return { state: "unknown" };
    const reviewers = environment.protection_rules.filter((rule) => rule.type === "required_reviewers").reduce((count, rule) => count + (Array.isArray(rule.reviewers) ? rule.reviewers.length : 0), 0);
    return reviewers > 0 ? { state: "configured", reviewers } : { state: "not_configured" };
  }
  return { state: "unknown" };
}

type Db = NonNullable<PluginSelectionEnv["DB"]>;
type Phase = "disabled" | "enabled" | "retained" | "deleting" | "deleted";
async function modulePhases(db: Db): Promise<Map<string, Phase>> {
  const rows = await db.prepare("SELECT module_id AS moduleId, phase FROM platform_modules WHERE installation_id = 'primary'").all<{ moduleId: string; phase: Phase }>();
  return new Map((rows.results ?? []).map((row) => [row.moduleId, row.phase]));
}
const firstPartyIds = new Set(firstPartyModules.map((module) => module.id));

export type PendingChange = { kind: "add" | "upgrade" | "remove" | "revert"; id: string; source?: string; commit?: string; installedCommit?: string };
/**
 * Changes the committed selection makes to the plugins this build runs. Official modules are included unless the selection
 * opts out; one listed in the selection uses its pin, and one not listed uses LancerLogin's pin for this release.
 */
export function pendingChanges(document: SelectionDocument, installed: InstalledPlugins): PendingChange[] {
  const changes: PendingChange[] = [];
  const chosen = new Map(document.modules.map((entry) => [entry.id, entry]));
  const includeOfficial = document.officialModules !== false;
  for (const entry of document.modules) {
    const current = installed[entry.id];
    if (!current) changes.push({ kind: "add", id: entry.id, source: entry.source, commit: entry.commit });
    else if (current.commit !== entry.commit || current.source !== entry.source) changes.push({ kind: "upgrade", id: entry.id, source: entry.source, commit: entry.commit, installedCommit: current.commit });
  }
  for (const [id, current] of Object.entries(installed)) {
    if (chosen.has(id)) continue;
    if (current.official && includeOfficial) { if (current.selected) changes.push({ kind: "revert", id, installedCommit: current.commit }); continue; }
    // A build composed before plugin management recorded no origin; treat its unlisted plugins as official while included.
    if (current.official === undefined && current.selected === undefined && includeOfficial) continue;
    changes.push({ kind: "remove", id, installedCommit: current.commit });
  }
  return changes;
}

export type PluginStateOptions = { installed?: InstalledPlugins; principal: Principal; passwordAvailable: boolean; googleAvailable: boolean };
export async function pluginManagementState(env: PluginSelectionEnv, options: PluginStateOptions) {
  const installed = options.installed ?? externalModuleSources;
  const db = env.DB ?? fail(503, "not_configured", "D1 is not linked.");
  const credential = selectionCredentialState(env);
  let configured = true;
  try { repository(env); } catch { configured = false; }
  const [phases, active, protection] = await Promise.all([modulePhases(db), startedUpdate(env), configured ? readProductionProtection(env) : Promise.resolve<Protection>({ state: "unknown" })]);
  let selection: SelectionSnapshot | null = null; let allowlist: Allowlist | { state: "unknown" } = { state: "unknown" }; let error: { code: string; message: string } | null = null;
  if (configured && credential.state === "ready") {
    try { selection = await readSelection(env); allowlist = await readAllowlist(env); }
    catch (cause) { if (!(cause instanceof WebUpdateError)) throw cause; error = { code: cause.code, message: cause.message }; }
  }
  const phase = (id: string) => phases.get(id) ?? null;
  return {
    releaseVersion: env.RELEASE_VERSION ?? "development",
    repository: configured ? env.UPDATE_REPOSITORY : null,
    credential,
    selection: selection ? { sha: selection.sha, present: selection.present, officialModules: selection.document.officialModules !== false, modules: selection.document.modules.map((entry) => ({ id: entry.id, source: entry.source, commit: entry.commit, track: entryTrack(entry), phase: phase(entry.id) })) } : null,
    installed: Object.entries(installed).map(([id, value]) => ({ id, source: value.source, commit: value.commit, official: Boolean(value.official), selected: Boolean(value.selected), phase: phase(id) })),
    pending: selection ? pendingChanges(selection.document, installed) : [],
    allowlist: allowlist.state === "configured" ? { state: "configured", sources: allowlist.sources.map((entry) => entry.owner ? `${entry.host}/${entry.owner}` : entry.host) } : { state: allowlist.state },
    protection,
    activeUpdate: active ? { requestId: active.id, mode: active.mode ?? "release", state: active.state } : null,
    reauthentication: { freshUntil: freshUntil(options.principal), password: options.passwordAvailable, google: options.googleAvailable },
    error,
  };
}

/** Only a full sign-in session counts; short-lived signed state tokens never prove fresh authentication. */
export function freshUntil(principal: Principal, sessionTtlMs = 8 * 60 * 60_000): number | null {
  if (typeof principal.authenticatedAt !== "number" || principal.expiresAt - principal.authenticatedAt !== sessionTtlMs) return null;
  const until = principal.authenticatedAt + reauthenticationWindowMs;
  return until > Date.now() ? until : null;
}

export type ChangeAction = "add" | "upgrade" | "remove";
/** track: the release track to record. Omitted on an upgrade, the plugin keeps its current track; omitted on an add, stable. */
type ChangeInput = { action: ChangeAction; id: string; source?: string; commit?: string; track?: SelectionTrack };
function readTrack(value: unknown): SelectionTrack | undefined {
  if (value !== undefined && !selectionTracks.includes(value as SelectionTrack)) fail(400, "invalid_request", "Choose the Stable or Nightly release track.");
  return value as SelectionTrack | undefined;
}
function readChangeInput(input: Record<string, unknown>, extra: readonly string[]): ChangeInput {
  if (Object.keys(input).some((key) => !["action", "id", "source", "commit", "track", ...extra].includes(key))) fail(400, "invalid_request", "Only the plugin action, module ID, source, commit and release track are accepted.");
  if (!["add", "upgrade", "remove"].includes(String(input.action))) fail(400, "invalid_request", "Choose add, upgrade or remove.");
  if (typeof input.id !== "string" || !moduleIdPattern.test(input.id) || input.id.length > 64) fail(400, "invalid_request", "Enter a module ID of lowercase letters, digits and single hyphens.");
  const action = input.action as ChangeAction;
  if (action === "remove") {
    if (input.source !== undefined || input.commit !== undefined || input.track !== undefined) fail(400, "invalid_request", "Removal takes only the module ID.");
    return { action, id: input.id };
  }
  if (typeof input.commit !== "string" || !commitPattern.test(input.commit)) fail(400, "invalid_request", "Enter the full 40-character lowercase commit SHA. Branches, tags and shortened SHAs are not accepted.");
  const track = readTrack(input.track);
  try { return { action, id: input.id, source: parseModuleSource(input.source, input.id).href, commit: input.commit, ...(track ? { track } : {}) }; }
  catch (error) { if (error instanceof SelectionError) fail(400, "invalid_request", error.message); throw error; }
}

/** The selection after a change, validated with composition's own rules. */
function proposedSelection(current: SelectionDocument, change: ChangeInput, installed: InstalledPlugins, phases: Map<string, Phase>): { document: SelectionDocument; previous?: SelectionEntry } {
  const previous = current.modules.find((entry) => entry.id === change.id);
  const official = installed[change.id]?.official === true;
  if (firstPartyIds.has(change.id)) fail(409, "first_party_module", `${change.id} is part of LancerLogin and cannot be selected as a plugin.`);
  let modules: SelectionEntry[];
  if (change.action === "add") {
    if (previous) fail(409, "already_selected", `${change.id} is already selected. Upgrade it instead.`);
    if (installed[change.id]) fail(409, "already_installed", `${change.id} is already installed. Upgrade it instead.`);
    modules = [...current.modules, { id: change.id, source: change.source!, commit: change.commit!, ...(change.track === "nightly" ? { track: "nightly" as const } : {}) }];
  } else if (change.action === "upgrade") {
    if (!previous && !installed[change.id]) fail(409, "not_selected", `${change.id} is not installed or selected. Add it instead.`);
    const track = change.track ?? entryTrack(previous);
    if (previous?.commit === change.commit && previous?.source === change.source && entryTrack(previous) === track) fail(409, "unchanged", `${change.id} is already pinned to that commit on that release track.`);
    const entry = { id: change.id, source: change.source!, commit: change.commit!, ...(track === "nightly" ? { track: "nightly" as const } : {}) };
    modules = previous ? current.modules.map((item) => item.id === change.id ? entry : item) : [...current.modules, entry];
  } else {
    if (!previous) fail(409, "not_selected", official ? `${change.id} is included with LancerLogin. Opt out of official modules in the private repository to remove it.` : `${change.id} is not in the plugin selection.`);
    // Removing an official module's pin returns it to LancerLogin's pin; any other removal takes the module's code away.
    const removesCode = !official || current.officialModules === false;
    const phase = phases.get(change.id);
    if (removesCode && (phase === "enabled" || phase === "retained" || phase === "deleting")) fail(409, "module_in_use", phase === "enabled" ? `Disable ${change.id} before removing its plugin.` : `${change.id} still has retained data. Remove its plugin after the retained data is deleted.`);
    modules = current.modules.filter((item) => item.id !== change.id);
  }
  // Official module sources may not be reused by another selected module, exactly as composition refuses.
  for (const entry of modules) {
    const officialOwner = Object.entries(installed).find(([id, value]) => value.official && id !== entry.id && value.source === entry.source);
    if (officialOwner && current.officialModules !== false) fail(409, "invalid_request", `${entry.source} is the source of official module ${officialOwner[0]}.`);
  }
  const document = { modules, ...(current.officialModules !== undefined ? { officialModules: current.officialModules } : {}) };
  try { return { document: parseSelectionFile(serializeSelection(document)), previous }; }
  catch (error) { if (error instanceof SelectionError) fail(409, "invalid_request", error.message); throw error; }
}

export type PluginMetadata = {
  state: "compatible" | "incompatible" | "unknown"; reason?: string;
  version?: string; contract?: number; core?: string; tablePrefix?: string; migrations?: string[]; adoptedCoreMigrations?: number;
};
/**
 * Read a plugin's package.json and migration names at the pinned commit through GitHub's public API, without credentials
 * and without running any plugin code. Other hosts, private repositories and provider failures are reported as unknown.
 */
export async function readPluginMetadata(source: string, commit: string, moduleId: string, coreVersion: string | undefined): Promise<PluginMetadata> {
  const url = new URL(source);
  if (url.hostname !== "github.com") return { state: "unknown", reason: "Compatibility is checked during composition. Only github.com sources can be inspected here." };
  const [, owner, name] = url.pathname.replace(/\.git$/, "").split("/");
  const get = async (path: string, accept: string) => {
    try { return await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${path}?ref=${commit}`, { headers: githubHeaders(undefined, accept), redirect: "manual", signal: AbortSignal.timeout(4_000) }); }
    catch { return undefined; }
  };
  const response = await get("package.json", "application/vnd.github.raw+json");
  if (!response?.ok) return { state: "unknown", reason: response?.status === 404 ? "The plugin's package.json was not found at that commit, or the repository is private. Composition checks it before the change is applied." : "GitHub could not be reached to inspect the plugin. Composition checks it before the change is applied." };
  let pkg: { version?: unknown; lancerlogin?: { moduleId?: unknown; contract?: unknown; core?: unknown; tablePrefix?: unknown; migrations?: unknown; adoptedCoreMigrations?: unknown } };
  try { pkg = JSON.parse((await response.text()).slice(0, 65_536)); } catch { return { state: "incompatible", reason: "The plugin's package.json is not valid JSON." }; }
  const field = pkg?.lancerlogin;
  if (!field || typeof field !== "object") return { state: "incompatible", reason: "The plugin's package.json has no lancerlogin field." };
  const metadata: PluginMetadata = { state: "compatible", version: typeof pkg.version === "string" ? pkg.version.slice(0, 40) : undefined, contract: typeof field.contract === "number" ? field.contract : undefined, core: typeof field.core === "string" ? field.core.slice(0, 200) : undefined, tablePrefix: typeof field.tablePrefix === "string" ? field.tablePrefix.slice(0, 40) : undefined, adoptedCoreMigrations: Array.isArray(field.adoptedCoreMigrations) ? field.adoptedCoreMigrations.length : undefined };
  if (field.moduleId !== moduleId) return { ...metadata, state: "incompatible", reason: `The plugin declares module ID ${JSON.stringify(field.moduleId)}, not ${moduleId}.` };
  if (typeof field.contract !== "number" || !supportedModuleContractVersions.includes(field.contract)) return { ...metadata, state: "incompatible", reason: `The plugin needs module contract ${String(field.contract)}; this LancerLogin supports ${supportedModuleContractVersions.join(", ")}.` };
  if (!coreVersion || !parseReleaseVersion(coreVersion)) { metadata.state = "unknown"; metadata.reason = "This installation is not running an official release, so its Core range cannot be checked."; }
  else {
    try { if (!satisfiesCoreRange(coreVersion, field.core)) return { ...metadata, state: "incompatible", reason: `The plugin supports LancerLogin ${String(field.core)}; this installation runs ${coreVersion}.` }; }
    catch (error) { if (error instanceof SelectionError) return { ...metadata, state: "incompatible", reason: error.message }; throw error; }
  }
  if (typeof field.migrations === "string" && /^\.\/[A-Za-z0-9_./-]{1,100}$/.test(field.migrations) && !field.migrations.split("/").includes("..")) {
    const listing = await get(field.migrations.slice(2).replace(/\/$/, ""), "application/vnd.github+json");
    const files = listing?.ok ? await listing.json().catch(() => undefined) as Array<{ name?: unknown; type?: unknown }> | undefined : undefined;
    if (Array.isArray(files)) metadata.migrations = files.filter((file) => file.type === "file" && typeof file.name === "string" && /^\d{4}_[a-z0-9_.]+\.sql$/.test(file.name)).map((file) => file.name as string).sort().slice(0, 50);
  } else if (field.migrations === undefined) metadata.migrations = [];
  return metadata;
}

/** Confirmation details for a proposed change. Nothing is committed. */
export async function reviewPluginChange(env: PluginSelectionEnv, input: Record<string, unknown>, installed: InstalledPlugins = externalModuleSources) {
  const change = readChangeInput(input, []);
  const db = env.DB ?? fail(503, "not_configured", "D1 is not linked.");
  const [selection, phases] = [await readSelection(env), await modulePhases(db)];
  const allowlist = await readAllowlist(env);
  const { previous } = proposedSelection(selection.document, change, installed, phases);
  if (change.source && !sourceAllowed(change.source, allowlist)) fail(403, "source_not_allowed", allowlist.state === "invalid" ? `${allowlistFileName} is invalid, so no plugin source can be selected. Repair it in the private deployment repository.` : "This installation's source allowlist does not include that plugin host and owner.");
  const metadata = change.action === "remove" ? undefined : await readPluginMetadata(change.source!, change.commit!, change.id, env.RELEASE_VERSION);
  return {
    action: change.action, id: change.id, source: change.source ?? previous?.source ?? installed[change.id]?.source ?? null, commit: change.commit ?? null,
    previousCommit: previous?.commit ?? installed[change.id]?.commit ?? null, official: installed[change.id]?.official === true,
    track: change.action === "remove" ? null : change.track ?? (change.action === "upgrade" ? entryTrack(previous) : "stable"), previousTrack: previous || installed[change.id] ? entryTrack(previous) : null,
    selectionSha: selection.sha, metadata: metadata ?? null, declaredNote: undeclaredNote, trustStatement,
    allowlist: allowlist.state === "configured" ? "allowed" : allowlist.state,
  };
}

/** Commit one change to lancerlogin.modules.json, optimistically on the blob the Admin reviewed. */
export async function commitPluginChange(env: PluginSelectionEnv, principal: Principal, input: Record<string, unknown>, installed: InstalledPlugins = externalModuleSources) {
  const change = readChangeInput(input, ["selectionSha", "trustConfirmed"]);
  if (typeof input.selectionSha !== "string" || !commitPattern.test(input.selectionSha)) fail(400, "invalid_request", "Review the change before confirming it.");
  if (change.action !== "remove" && input.trustConfirmed !== true) fail(400, "trust_confirmation_required", "Confirm that you trust this plugin's source and reviewed the pinned commit.");
  if (change.action === "remove" && input.trustConfirmed !== undefined && input.trustConfirmed !== true) fail(400, "invalid_request", "Removal needs no trust confirmation.");
  if (!freshUntil(principal)) fail(401, "reauthentication_required", "Confirm your identity again before changing plugins.");
  const db = env.DB ?? fail(503, "not_configured", "D1 is not linked.");
  if (await startedUpdate(env)) fail(409, "update_active", "A web update is in progress. Change plugins after it finishes.");
  const selection = await readSelection(env);
  if (selection.sha !== input.selectionSha) fail(409, "selection_changed", "The plugin selection changed since you reviewed it. Review the change again.");
  const allowlist = await readAllowlist(env);
  if (change.source && !sourceAllowed(change.source, allowlist)) fail(403, "source_not_allowed", "This installation's source allowlist does not permit that plugin source.");
  const { document, previous } = proposedSelection(selection.document, change, installed, await modulePhases(db));
  const short = (sha?: string) => sha ? sha.slice(0, 12) : "";
  const track = change.action === "remove" ? null : entryTrack(document.modules.find((entry) => entry.id === change.id));
  const previousTrack = previous || installed[change.id] ? entryTrack(previous) : null;
  const onTrack = track === "nightly" ? " on the nightly track" : "";
  const subject = change.action === "add" ? `Add plugin ${change.id} at ${short(change.commit)}${onTrack}`
    : change.action === "upgrade" ? previous?.commit === change.commit && previous?.source === change.source ? `Set plugin ${change.id} release track to ${track}` : `Pin plugin ${change.id} at ${short(change.commit)}${onTrack}`
    : `Remove plugin ${change.id}`;
  const body = { message: `${subject}\n\nRequested in LancerLogin Settings > Modules by Admin user ${principal.userId}.`, content: encodeBase64Text(serializeSelection(document)), branch: selectionBranch, ...(selection.present ? { sha: selection.sha } : {}) };
  const response = await privateGitHub(env, `/repos/${repository(env)}/contents/${selectionFileName}`, { method: "PUT", body: JSON.stringify(body) });
  if (response.status === 409 || response.status === 422) fail(409, "selection_changed", "The plugin selection changed in the private repository. Review the change again.");
  if (response.status === 404) fail(503, "selection_credential_permission", "The plugin selection credential cannot write to the private deployment repository.");
  const result = response.ok ? await response.json().catch(() => undefined) as { content?: { sha?: string }; commit?: { sha?: string } } | undefined : undefined;
  if (!result?.content?.sha || !result.commit?.sha) fail(503, "commit_unconfirmed", "GitHub did not confirm the commit. Reload to see the current selection before trying again.");
  const now = new Date().toISOString(); const auditId = crypto.randomUUID();
  const metadata = { action: change.action, moduleId: change.id, source: change.source ?? previous?.source ?? null, commit: change.commit ?? null, previousCommit: previous?.commit ?? null, track, previousTrack, selectionSha: result.content.sha, repositoryCommit: result.commit.sha };
  const statements = [
    db.prepare("INSERT INTO audit_log (id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, 'primary', ?, 'module_selection.changed', 'module_plugin', ?, ?, ?)").bind(auditId, principal.userId, change.id, JSON.stringify(metadata), now),
    // A prepared update pinned the previous selection; it must be prepared again.
    db.prepare("UPDATE web_update_requests SET state = 'expired', error_code = 'module_selection_changed', updated_at = ? WHERE installation_id = 'primary' AND state = 'prepared'").bind(now),
  ];
  if (db.batch) await db.batch(statements); else for (const statement of statements) await statement.run();
  return { committed: { action: change.action, id: change.id, commit: change.commit ?? null, track, selectionSha: result.content.sha, repositoryCommit: result.commit.sha } };
}

export type PluginRelease = { tag: string; kind: "stable" | "beta" | "nightly"; commit: string; url: string | null };
/**
 * The newest published, immutable release on a plugin's release track, resolved to its full commit SHA, for the Upgrade
 * dialog to offer. Stable offers stable releases only; Nightly (testing only) also offers beta and nightly prereleases,
 * exactly as `npm run plugins:resolve` does. Releases are read through GitHub's public API without credentials, so
 * other hosts and private repositories report a reason instead, and the Admin enters the reviewed commit. Nothing is
 * committed: the chosen commit goes through review, trust confirmation and fresh authentication like any change.
 */
export async function newestTrackRelease(source: string, track: SelectionTrack): Promise<{ track: SelectionTrack; release: PluginRelease | null; reason?: string }> {
  const url = new URL(source);
  if (url.hostname !== "github.com") return { track, release: null, reason: "Releases can be looked up only for github.com sources. Enter the commit you reviewed." };
  const [, owner, name] = url.pathname.replace(/\.git$/, "").split("/");
  const get = async (path: string) => {
    try { return await fetch(`https://api.github.com/repos/${owner}/${name}${path}`, { headers: githubHeaders(), redirect: "manual", signal: AbortSignal.timeout(4_000) }); }
    catch { return undefined; }
  };
  const unavailable = (response: Response | undefined) => ({ track, release: null, reason: response?.status === 404 ? "The plugin's releases were not found, or its repository is private. Enter the commit you reviewed." : response?.status === 403 || response?.status === 429 ? "GitHub requires a cooldown before releases can be looked up. Try again later, or enter the commit you reviewed." : "GitHub could not be reached to look up releases. Enter the commit you reviewed." });
  // The highest version wins, never the most recent publication, so read every page (bounded) before choosing.
  const releases: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await get(`/releases?per_page=100&page=${page}`);
    if (!response?.ok) return unavailable(response);
    const batch = await response.json().catch(() => undefined) as unknown;
    if (!Array.isArray(batch)) return unavailable(undefined);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const release = newestPluginRelease<{ tag_name?: unknown; html_url?: unknown }>(releases, track);
  if (!release || typeof release.tag_name !== "string") return { track, release: null, reason: `No published, immutable release is on the ${track === "nightly" ? "Nightly" : "Stable"} track.` };
  const tag = release.tag_name;
  const response = await get(`/commits/${encodeURIComponent(tag)}`);
  if (!response?.ok) return unavailable(response);
  const commit = (await response.json().catch(() => undefined) as { sha?: unknown } | undefined)?.sha;
  if (typeof commit !== "string" || !commitPattern.test(commit)) return unavailable(undefined);
  const page = typeof release.html_url === "string" && release.html_url.startsWith(`https://github.com/${owner}/${name}/releases/`) ? release.html_url : null;
  return { track, release: { tag, kind: pluginReleaseKind(tag)!, commit, url: page } };
}
/** Admin lookup for the Upgrade dialog: { id, source, track }. Read-only; the selection credential is never used. */
export async function lookupPluginRelease(input: Record<string, unknown>) {
  if (Object.keys(input).some((key) => !["id", "source", "track"].includes(key))) fail(400, "invalid_request", "Only the module ID, source and release track are accepted.");
  if (typeof input.id !== "string" || !moduleIdPattern.test(input.id) || input.id.length > 64) fail(400, "invalid_request", "Enter a module ID of lowercase letters, digits and single hyphens.");
  const track = readTrack(input.track) ?? fail(400, "invalid_request", "Choose the Stable or Nightly release track.");
  let source: string;
  try { source = parseModuleSource(input.source, input.id).href; }
  catch (error) { if (error instanceof SelectionError) fail(400, "invalid_request", error.message); throw error; }
  return newestTrackRelease(source, track);
}

export type RequiredMigration = { id: string; label: string; plugin: { source: string; commit: string } | null };
/**
 * Modules that moved out of LancerLogin into plugins, that this installation uses, and that the next build would not
 * compose: the committed selection plus the official modules (or, without a readable selection, the plugins installed now).
 * Updating without the plugin would stop the module, so preparation refuses until the Admin keeps or removes it.
 */
export async function requiredModuleMigrations(env: PluginSelectionEnv, installed: InstalledPlugins = externalModuleSources): Promise<RequiredMigration[]> {
  const db = env.DB ?? fail(503, "not_configured", "D1 is not linked.");
  let selection: SelectionSnapshot | null = null;
  if (selectionCredentialState(env).state === "ready") selection = await readSelection(env).catch(() => null);
  // A build composed before plugin management recorded no origin; its unlisted plugins were official.
  const official = Object.entries(installed).filter(([, value]) => value.official === true || value.official === undefined && value.selected === undefined).map(([id]) => id);
  const composed = new Set(selection ? [...(selection.document.officialModules !== false ? official : []), ...selection.document.modules.map((entry) => entry.id)] : Object.keys(installed));
  const query = async (sql: string, params: readonly unknown[] = []) => (await db.prepare(sql).bind(...params).all<Record<string, unknown>>()).results ?? [];
  return (await extractedModulesInUse(query, composed)).map((module) => {
    const plugin = knownModule(module.id);
    return { id: module.id, label: module.label, plugin: plugin ? { source: plugin.source, commit: plugin.commit } : null };
  });
}
export async function requireNoModuleMigration(env: PluginSelectionEnv, installed?: InstalledPlugins): Promise<void> {
  const required = await requiredModuleMigrations(env, installed);
  if (required.length) fail(409, "module_migration_required", `${required.map((module) => module.label).join(" and ")} ${required.length === 1 ? "is" : "are"} in use and now ${required.length === 1 ? "a separate plugin" : "separate plugins"}. Keep ${required.length === 1 ? "it" : "them"} by adding the plugin in Settings > Modules, or disable ${required.length === 1 ? "it" : "them"} there, before updating.`);
}
