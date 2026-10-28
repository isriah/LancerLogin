// Plugin sources for Core's own tests and test runners. Never used by installation builds or web updates.
//
// Official and test plugin pins name https repositories, public or private. A test that composes or reads one uses, in order:
//   1. an explicit override for that module, LANCERLOGIN_<NAME>_PLUGIN_SOURCE and LANCERLOGIN_<NAME>_PLUGIN_COMMIT
//      (NAME is OUTREACH for hour-tracking, otherwise the module ID in capitals), as a plugin repository's CI sets;
//   2. the https source with LANCERLOGIN_PLUGIN_TOKEN, when it is set (read access to a private plugin repository);
//   3. a local development checkout of the same repository that contains the pinned commit, found under
//      LANCERLOGIN_PLUGIN_CHECKOUTS (directories separated by the platform path delimiter), <core>/../module-plugins or
//      <core>/.local/module-plugins, and named after the repository (for example lancerlogin-outreach);
//   4. the https source fetched anonymously, which works for public plugin repositories such as the official ones.
// Only an invalid or half-set pin is unavailable up front. A fetch that fails (a private repository without a token, or no
// network) fails composition, and callers report that error with unreachablePinAdvice.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedGitEnv } from "./git-env.mjs";

export const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const pluginTokenVariable = "LANCERLOGIN_PLUGIN_TOKEN";
const commitPattern = /^[0-9a-f]{40}$/;

/** The environment name stem for a module's override variables. */
export const overrideName = (moduleId) => moduleId === "hour-tracking" ? "OUTREACH" : moduleId.toUpperCase().replaceAll("-", "_");

/** An explicit source/commit override for one module, a string reason when only half is set, or undefined. */
export function pluginOverride(moduleId, env = process.env) {
  const name = overrideName(moduleId);
  const source = env[`LANCERLOGIN_${name}_PLUGIN_SOURCE`]; const commit = env[`LANCERLOGIN_${name}_PLUGIN_COMMIT`];
  if (!source && !commit) return;
  if (!source || !commit) return `Set both LANCERLOGIN_${name}_PLUGIN_SOURCE and LANCERLOGIN_${name}_PLUGIN_COMMIT`;
  return { id: moduleId, source, commit };
}

const repositoryName = (source) => /\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(new URL(source).pathname)?.[1];
const hasCommit = (directory, commit) => existsSync(join(directory, ".git")) && spawnSync("git", ["-C", directory, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore", env: isolatedGitEnv() }).status === 0;

/** Directories searched for local plugin checkouts. */
export function localCheckoutDirectories(env = process.env, root = coreRoot) {
  return [...(env.LANCERLOGIN_PLUGIN_CHECKOUTS ?? "").split(delimiter).filter(Boolean), join(root, "..", "module-plugins"), join(root, ".local", "module-plugins")].map((path) => resolve(path));
}

/**
 * Resolve one pin for a test. Returns { pin, via } where via is "override", "file", "token", "local" or "anonymous" and
 * pin.source may be a file:// URL (tests compose with --test-allow-file-sources), or { reason } when the pin is unusable.
 */
export function resolveTestPin(pin, { env = process.env, root = coreRoot } = {}) {
  const override = pluginOverride(pin.id, env);
  if (typeof override === "string") return { reason: override };
  const chosen = override ?? pin;
  if (!commitPattern.test(chosen.commit)) return { reason: `The ${pin.id} plugin pin ${chosen.commit} is not a full commit SHA` };
  let url;
  try { url = new URL(chosen.source); } catch { return { reason: `The ${pin.id} plugin source ${chosen.source} is not a URL` }; }
  if (url.protocol === "file:") {
    const directory = fileURLToPath(url);
    return existsSync(directory) ? { pin: chosen, via: override ? "override" : "file" } : { reason: `The ${pin.id} plugin repository is not available at ${chosen.source}` };
  }
  if (url.protocol !== "https:") return { reason: `The ${pin.id} plugin source ${chosen.source} is neither https nor file` };
  if (env[pluginTokenVariable]) return { pin: chosen, via: "token" };
  const name = repositoryName(chosen.source);
  for (const directory of localCheckoutDirectories(env, root)) {
    const checkout = join(directory, name);
    if (hasCommit(checkout, chosen.commit)) return { pin: { ...chosen, source: pathToFileURL(checkout).href }, via: "local" };
  }
  // Public repositories need no token: composition fetches the pinned commit anonymously.
  return { pin: chosen, via: "anonymous" };
}

/** What to add when an https pin could not be fetched: how to reach a private repository or work offline. */
export function unreachablePinAdvice(pin, { env = process.env, root = coreRoot } = {}) {
  let name;
  try { name = repositoryName(pin.source); } catch { name = undefined; }
  return `If ${pin.source} is private, set ${pluginTokenVariable} to a token with read access to it; otherwise provide a local checkout named ${name ?? pin.id} containing ${pin.commit} in LANCERLOGIN_PLUGIN_CHECKOUTS or one of: ${localCheckoutDirectories(env, root).join(", ")}`;
}

/** Core's official module list, parsed only as far as tests need. */
export function officialModuleList(root = coreRoot) {
  return JSON.parse(readFileSync(join(root, "scripts", "official-modules.json"), "utf8"));
}

/**
 * Prepare a test composition: Core's official modules (unless excluded) plus `modules`, with every pin resolved as
 * above. Returns { args, env, cleanup, modules } for scripts/compose-modules.mjs, or { reason } when a plugin is
 * unavailable. `modules` lists the effective pins (official first, as composition orders them).
 */
export function prepareTestComposition({ modules = [], officialModules = true, env = process.env, root = coreRoot, scratch } = {}) {
  const official = officialModules ? officialModuleList(root) : undefined;
  const resolveAll = (pins) => {
    const resolved = [];
    for (const pin of pins) { const result = resolveTestPin(pin, { env, root }); if (result.reason) return result.reason; resolved.push(result.pin); }
    return resolved;
  };
  // A module overridden through the environment replaces its official pin, as an installation pinning another commit would.
  const selected = [...modules, ...(official?.modules ?? []).filter((pin) => pluginOverride(pin.id, env) && !modules.some((module) => module.id === pin.id))];
  const officialPins = resolveAll(official?.modules ?? []);
  if (typeof officialPins === "string") return { reason: officialPins };
  const selectionPins = resolveAll(selected);
  if (typeof selectionPins === "string") return { reason: selectionPins };
  const directory = scratch ?? mkdtempSync(join(tmpdir(), "lancerlogin-test-composition-"));
  const selectionFile = join(directory, "lancerlogin.modules.json");
  writeFileSync(selectionFile, JSON.stringify({ format: 1, modules: selectionPins.map(({ id, source, commit }) => ({ id, source, commit })) }));
  const args = ["--selection", selectionFile, "--test-allow-file-sources"];
  if (official) {
    const officialFile = join(directory, "official-modules.json");
    writeFileSync(officialFile, JSON.stringify({ format: 1, status: official.status, modules: officialPins.map(({ id, source, commit }) => ({ id, source, commit })) }));
    args.push("--official-list", officialFile);
  } else args.push("--no-official-modules");
  const chosen = new Map(selectionPins.map((pin) => [pin.id, pin]));
  const effective = [...officialPins.map((pin) => chosen.get(pin.id) ?? pin), ...selectionPins.filter((pin) => !officialPins.some((item) => item.id === pin.id))];
  return {
    args, modules: effective,
    env: { ...env, [pluginTokenVariable]: env[pluginTokenVariable] ?? "" },
    cleanup: () => { if (!scratch) rmSync(directory, { recursive: true, force: true }); },
  };
}

/** Read a test selection file (tests/fixtures/*.modules.json) as plain pins. */
export function readTestSelection(path, root = coreRoot) {
  const value = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  return { modules: value.modules ?? [], officialModules: value.officialModules !== false };
}
