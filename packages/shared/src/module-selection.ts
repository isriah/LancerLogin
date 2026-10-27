/**
 * The installation's plugin selection file, lancerlogin.modules.json, kept in its private deployment repository.
 * Composition (scripts/compose-modules.mjs) and the Worker's dashboard plugin management parse it with these rules,
 * so a selection the dashboard writes is always one composition accepts.
 */
import { compareReleaseVersions, parseReleaseVersion, pluginSelectionTracks, type PluginSelectionTrack } from "./release-policy.mjs";

export const selectionFileName = "lancerlogin.modules.json";
export const pluginTokenVariable = "LANCERLOGIN_PLUGIN_TOKEN";
export const maximumSelectedModules = 32;
export const moduleIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const commitPattern = /^[0-9a-f]{40}$/;

/**
 * `track` is the release track the dashboard's Upgrade offers for this plugin: absent (or "stable") for stable releases,
 * "nightly" for testing-only nightly prereleases. It never changes what is built; composition uses the pinned commit.
 */
export type SelectionEntry = { readonly id: string; readonly source: string; readonly commit: string; readonly track?: "nightly" };
export type SelectionTrack = PluginSelectionTrack;
export const selectionTracks = pluginSelectionTracks;
/** The entry's release track, defaulting to stable. */
export const entryTrack = (entry: { track?: string } | undefined): SelectionTrack => entry?.track === "nightly" ? "nightly" : "stable";
export type SelectionDocument = { readonly modules: readonly SelectionEntry[]; readonly officialModules?: boolean; readonly status?: string };

export class SelectionError extends Error {
  constructor(message: string) { super(message); this.name = "SelectionError"; }
}
const fail = (message: string): never => { throw new SelectionError(message); };
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function exactKeys(value: unknown, required: readonly string[], optional: readonly string[], context: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) fail(`${context} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !required.includes(key) && !optional.includes(key));
  if (unknown.length) fail(`${context} has unknown keys: ${unknown.join(", ")}`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length) fail(`${context} is missing: ${missing.join(", ")}`);
}

/**
 * Parse a selection file, including the optional `officialModules` flag (true when absent: compose the official modules).
 * `name` labels errors, so Core's official list reports its own file name. file:// sources are accepted only for tests
 * and development builds that ask for them explicitly.
 */
export function parseSelectionFile(text: string, { allowFileSources = false, name = selectionFileName, official = false }: { allowFileSources?: boolean; name?: string; official?: boolean } = {}): SelectionDocument {
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail(`${name} is not valid JSON`); }
  exactKeys(value, ["format", "modules"], official ? ["status"] : ["officialModules"], name);
  if (value.format !== 1) fail(`${name} format must be 1`);
  if (value.officialModules !== undefined && typeof value.officialModules !== "boolean") fail(`${name} officialModules must be true or false`);
  if (value.status !== undefined && (typeof value.status !== "string" || value.status.length > 40)) fail(`${name} status must be a short string`);
  if (!Array.isArray(value.modules) || value.modules.length > maximumSelectedModules) fail(`${name} modules must be an array of at most ${maximumSelectedModules} entries`);
  return { modules: parseSelectionEntries(value.modules as unknown[], name, allowFileSources), officialModules: value.officialModules as boolean | undefined, status: value.status as string | undefined };
}

export function parseSelectionEntries(modules: readonly unknown[], fileName = selectionFileName, allowFileSources = false): SelectionEntry[] {
  const ids = new Set<string>(); const sources = new Set<string>();
  return modules.map((entry, index) => {
    const context = `${fileName} module ${index + 1}`;
    exactKeys(entry, ["id", "source", "commit"], ["track"], context);
    if (typeof entry.id !== "string" || !moduleIdPattern.test(entry.id) || entry.id.length > 64) fail(`${context} has an invalid module ID`);
    const id = entry.id as string;
    if (ids.has(id)) fail(`${fileName} selects module ${id} more than once`);
    if (typeof entry.commit !== "string" || !commitPattern.test(entry.commit)) fail(`Module ${id} must be pinned to a full 40-character lowercase commit SHA; branches, tags and abbreviated SHAs are not accepted`);
    const source = parseModuleSource(entry.source, id, allowFileSources);
    if (sources.has(source.href)) fail(`${fileName} uses ${source.href} for more than one module`);
    if (entry.track !== undefined && !selectionTracks.includes(entry.track as SelectionTrack)) fail(`Module ${id} track ${JSON.stringify(entry.track)} is not supported; use "stable" or "nightly", or leave it out for stable`);
    ids.add(id); sources.add(source.href);
    return Object.freeze({ id, source: source.href, commit: entry.commit as string, ...(entry.track === "nightly" ? { track: "nightly" as const } : {}) });
  });
}

/** An https://host/owner/repository.git URL without credentials, a port, a query or a fragment. */
export function parseModuleSource(value: unknown, moduleId: string, allowFileSources = false): URL {
  if (typeof value !== "string" || value.length > 300) fail(`Module ${moduleId} source must be an https git URL`);
  let url!: URL;
  try { url = new URL(value as string); } catch { fail(`Module ${moduleId} source must be an https git URL`); }
  if (value !== url.href) fail(`Module ${moduleId} source must be a normalized URL`);
  if (url.protocol === "file:" && allowFileSources) {
    if (url.host || url.search || url.hash) fail(`Module ${moduleId} file source is invalid`);
    return url;
  }
  if (url.protocol !== "https:") fail(`Module ${moduleId} source must use https${allowFileSources ? " or file" : ""}`);
  if (url.username || url.password) fail(`Module ${moduleId} source must not contain credentials; use ${pluginTokenVariable} for private repositories`);
  if (url.port || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname) || url.pathname.includes("/../") || url.pathname.includes("/./")) fail(`Module ${moduleId} source must look like https://<host>/<owner>/<repository>.git`);
  return url;
}

/** Serialize a selection exactly as the dashboard commits it: stable key order, two-space indent, trailing newline. */
export function serializeSelection(document: { modules: readonly SelectionEntry[]; officialModules?: boolean }): string {
  const value: Record<string, unknown> = { format: 1 };
  if (document.officialModules !== undefined) value.officialModules = document.officialModules;
  value.modules = document.modules.map(({ id, source, commit, track }) => ({ id, source, commit, ...(track === "nightly" ? { track } : {}) }));
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The optional source allowlist, lancerlogin.plugin-sources.json, kept beside the selection file in the private deployment
 * repository and never written by the Worker. The Worker checks it for dashboard plugin changes and composition checks it
 * for every source the selection file names, with these same rules: an entry is a lowercase host (every owner on it) or
 * host/owner; the source's hostname must equal the host and, when an owner is given, its first path segment must equal
 * the owner ignoring case. Without the file any source is allowed; an invalid file allows none.
 */
export const allowlistFileName = "lancerlogin.plugin-sources.json";
export type AllowedSource = { host: string; owner?: string };
export type Allowlist = { state: "none" } | { state: "configured"; sources: AllowedSource[] } | { state: "invalid"; reason: string };
/** lancerlogin.plugin-sources.json: { "format": 1, "allowedSources": ["github.com/owner", "git.example.org"] }. */
export function parseAllowlist(text: string): Allowlist {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { state: "invalid", reason: `${allowlistFileName} is not valid JSON` }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "invalid", reason: `${allowlistFileName} must be an object` };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["format", "allowedSources"].includes(key)) || record.format !== 1 || !Array.isArray(record.allowedSources) || record.allowedSources.length > 100) return { state: "invalid", reason: `${allowlistFileName} must contain format 1 and an allowedSources array` };
  const sources: AllowedSource[] = [];
  for (const entry of record.allowedSources) {
    const match = typeof entry === "string" ? /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?:\/([A-Za-z0-9_.-]{1,100}))?$/.exec(entry) : null;
    if (!match) return { state: "invalid", reason: `${allowlistFileName} entries must look like host or host/owner` };
    sources.push({ host: match[1]!, ...(match[2] ? { owner: match[2] } : {}) });
  }
  return { state: "configured", sources };
}
export function sourceAllowed(source: string, allowlist: Allowlist): boolean {
  if (allowlist.state === "none") return true;
  if (allowlist.state !== "configured") return false;
  const url = new URL(source); const owner = url.pathname.split("/")[1]?.toLowerCase();
  return allowlist.sources.some((entry) => entry.host === url.hostname.toLowerCase() && (!entry.owner || entry.owner.toLowerCase() === owner));
}

/** Check a Core release version against a package.json-style range (space-separated comparators, || alternatives). */
export function satisfiesCoreRange(version: string, range: unknown): boolean {
  if (!parseReleaseVersion(version)) fail(`Core version ${version} is not a release version`);
  if (typeof range !== "string" || !range.trim() || range.length > 200) fail("Core range must be a non-empty string");
  const text = range as string;
  const prerelease = parseReleaseVersion(version)!.beta !== undefined;
  const base = version.replace(/-beta\.\d+$/, "");
  return text.split("||").some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).map((part) => {
      const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/.exec(part);
      if (!match || !parseReleaseVersion(match[2])) fail(`Core range ${JSON.stringify(text)} is not supported; use comparators such as >=2.0.0-beta.0 <3.0.0`);
      return { operator: match![1] ?? "=", version: match![2]! };
    });
    // As in npm semver, a beta Core satisfies a range only when a comparator names a beta of the same release.
    if (prerelease && !comparators.some((comparator) => comparator.version.includes("-beta.") && comparator.version.replace(/-beta\.\d+$/, "") === base)) return false;
    return comparators.every(({ operator, version: bound }) => {
      const order = compareReleaseVersions(version, bound)!;
      return operator === ">=" ? order >= 0 : operator === "<=" ? order <= 0 : operator === ">" ? order > 0 : operator === "<" ? order < 0 : order === 0;
    });
  });
}
