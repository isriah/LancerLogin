// Compose plugins for Core-side tests exactly as an installation build would, then point this process at the composed output.
// Composition runs in a child process with Core's official modules (scripts/official-modules.json, Outreach first) plus an
// optional test selection, so tests see the same module set an installation with that selection receives. Afterwards:
//   - Core's generated plugin lists resolve to the composed output, so application modules imported later include the plugins;
//   - `@lancerlogin/module-sdk` resolves to this Core's SDK, as composition guarantees for builds;
//   - `@lancerlogin-test/<alias>/<path>` resolves to a file in the composed checkout of the plugin with that alias.
// A process composes once: import one fixture (carpool-plugin.ts or outreach-plugin.ts) first, then import test bodies and
// application modules dynamically. When a plugin source is unavailable (for example a private plugin without
// LANCERLOGIN_PLUGIN_TOKEN or a local plugin checkout, or no network), `available` is false and callers register a skipped test that names the reason; the named environment switch fails instead.
// Test processes share compositions through a cache in the OS temp folder (see compositionCacheKey and cachedDirectory), so a
// test run composes each set of pins once. Set LANCERLOGIN_TEST_COMPOSITION_CACHE=0 to compose afresh in every process.
// quick-check: covers apps/api/migrations/**
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareTestComposition, unreachablePinAdvice } from "../../scripts/test-plugin-sources.mjs";

const coreRoot = fileURLToPath(new URL("../../", import.meta.url));
type Pin = { readonly id: string; readonly source: string; readonly commit: string };
export type ComposedPlugins =
  | { readonly available: true; readonly output: string; readonly roots: Readonly<Record<string, string>>; readonly modules: readonly Pin[] }
  | { readonly available: false; readonly reason: string };

/** Core's official module pins, as composition reads them. */
export function officialModulePins(): Pin[] {
  return (JSON.parse(readFileSync(join(coreRoot, "scripts/official-modules.json"), "utf8")) as { modules: Pin[] }).modules;
}

let composedOnce = false;
/**
 * Compose the official modules plus `selection` (plugins replacing or adding to them) and register resolution hooks.
 * `aliases` maps a test alias such as "carpool" to a module ID whose checkout `@lancerlogin-test/<alias>/` should reach.
 */
export function composeTestPlugins(input: { readonly selection: readonly Pin[]; readonly aliases: Readonly<Record<string, string>>; readonly requireVariable: string; readonly name: string }): ComposedPlugins {
  if (composedOnce) throw new Error("Compose test plugins once per process; import only one plugin fixture");
  composedOnce = true;
  let composed: ComposedPlugins;
  try { composed = compose(input.selection, input.name); }
  catch (error) { composed = { available: false, reason: error instanceof Error ? error.message : String(error) }; if (process.env[input.requireVariable] === "1") throw error; }
  if (!composed.available && process.env[input.requireVariable] === "1") throw new Error(composed.reason);
  if (composed.available) {
    const { output, roots } = composed;
    const aliases = Object.entries(input.aliases).map(([alias, moduleId]) => [`@lancerlogin-test/${alias}/`, roots[moduleId]!] as const);
    const redirected = ["packages/shared/src/generated/external-manifests.ts", "apps/api/src/generated/external-modules.ts", "apps/api/src/generated/external-module-data.ts"];
    const coreParent = pathToFileURL(join(coreRoot, "package.json")).href;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
        if (alias) return { url: pathToFileURL(join(alias[1], specifier.slice(alias[0].length))).href, shortCircuit: true };
        if (specifier === "@lancerlogin/module-sdk" || specifier.startsWith("@lancerlogin/module-sdk/")) return nextResolve(specifier, { ...context, parentURL: coreParent });
        const resolved = nextResolve(specifier, context);
        const target = redirected.find((path) => resolved.url.endsWith(`/${path}`));
        return target ? { ...resolved, url: pathToFileURL(join(output, target)).href } : resolved;
      },
    });
  }
  return composed;
}

function compose(selection: readonly Pin[], name: string): ComposedPlugins {
  const scratch = mkdtempSync(join(tmpdir(), `lancerlogin-${name}-plugins-`));
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
  // https pins compose with LANCERLOGIN_PLUGIN_TOKEN when it is set, otherwise from a local development checkout, otherwise
  // anonymously, which is enough for public plugins (see scripts/test-plugin-sources.mjs). A failure names what is missing.
  const prepared = prepareTestComposition({ modules: selection, scratch });
  if ("reason" in prepared) return { available: false, reason: prepared.reason as string };
  const modules = prepared.modules as Pin[];
  const build = (directory: string) => {
    const output = join(directory, "output");
    mkdirSync(join(output, "apps/dashboard/src"), { recursive: true });
    writeFileSync(join(output, "apps/dashboard/src/module-contributions.ts"), "export type DashboardModuleContribution = unknown;\n");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(coreRoot, "scripts/compose-modules.mjs"), ...prepared.args, "--output-root", output, "--work-directory", join(directory, "plugins")], { cwd: coreRoot, encoding: "utf8", env: prepared.env });
    if (result.status !== 0) {
      const remote = modules.filter((pin) => pin.source.startsWith("https:")).map((pin) => unreachablePinAdvice(pin));
      throw new Error(`Plugin composition failed: ${result.stderr}${result.stdout}${remote.length ? `\n${remote.join("\n")}` : ""}`);
    }
  };
  // Generated files import plugin files by relative path, so a composition stays valid when its directory moves as a whole.
  const complete = (directory: string) => existsSync(join(directory, "output/apps/api/src/generated/external-modules.ts")) && modules.every((pin) => existsSync(join(directory, "plugins", pin.id, "package.json")));
  let directory = join(scratch, "composed");
  if (process.env[compositionCacheVariable] === "0") build(directory);
  else {
    // The selection files prepareTestComposition wrote hold the effective pins; key on their content, not their scratch path.
    const args = (prepared.args as string[]).map((arg) => arg.startsWith(scratch) ? readFileSync(arg, "utf8") : arg);
    directory = cachedDirectory({ root: compositionCacheRoot(), key: compositionCacheKey(args), build, complete });
  }
  return { available: true, output: join(directory, "output"), roots: Object.fromEntries(modules.map((pin) => [pin.id, join(directory, "plugins", pin.id)])), modules };
}

export const compositionCacheVariable = "LANCERLOGIN_TEST_COMPOSITION_CACHE";
export const compositionCacheRoot = () => join(tmpdir(), "lancerlogin-test-compositions");

/**
 * Core files whose content decides what composition produces or refuses, besides the pins: the composer and its import
 * closure (including the first-party module registry it validates against), the Core migrations plugin tables are checked
 * against, the package files that give Core's version and the peer versions it provides, and this fixture.
 */
export function composerInputs(root = coreRoot): string[] {
  const files = new Set<string>();
  const queue = ["scripts/compose-modules.mjs", "scripts/inspect-module-plugin.mjs", "scripts/test-plugin-sources.mjs", relative(coreRoot, fileURLToPath(import.meta.url))].map((path) => resolve(root, path));
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport\s*\(?)\s*["'](\.{1,2}\/[^"'\s]+\.(?:mjs|js|ts))["']/g)) queue.push(resolve(dirname(file), match[1]!));
  }
  const migrations = join(root, "apps/api/migrations");
  for (const name of readdirSync(migrations)) files.add(join(migrations, name));
  for (const path of ["package.json", "package-lock.json", "packages/module-sdk/package.json", "apps/api/package.json", "apps/dashboard/package.json"]) if (existsSync(join(root, path))) files.add(join(root, path));
  return [...files].sort();
}

/** The cache key for a composition: the composer arguments (with the effective pins) and the content of every composer input. */
export function compositionCacheKey(args: readonly string[], root = coreRoot): string {
  const hash = createHash("sha256").update(JSON.stringify({ format: 1, args }));
  for (const file of composerInputs(root)) hash.update(`\0${relative(root, file).replaceAll("\\", "/")}\0`).update(readFileSync(file));
  return hash.digest("hex");
}

const markerName = "lancerlogin-composition.json";
const day = 24 * 60 * 60 * 1000;

/**
 * The directory cached under `key` in `root`, built first when it is missing or incomplete. `build` fills a fresh staging
 * directory beside the entry, which is then renamed into place, so readers never see a partial build. Processes that miss
 * at the same time each build; the first rename wins and the others discard their copy. A broken entry (for example one a
 * temp cleaner emptied) is moved aside and rebuilt. Entries unused for two weeks are removed when a new one is built.
 */
export function cachedDirectory(input: { readonly root: string; readonly key: string; readonly build: (directory: string) => void; readonly complete: (directory: string) => boolean }): string {
  const entry = join(input.root, input.key.slice(0, 32));
  const usable = () => {
    try { if ((JSON.parse(readFileSync(join(entry, markerName), "utf8")) as { key?: string }).key !== input.key || !input.complete(entry)) return false; }
    catch { return false; }
    try { const now = new Date(); utimesSync(join(entry, markerName), now, now); } catch { /* last-use time is advisory */ }
    return true;
  };
  if (usable()) return entry;
  mkdirSync(input.root, { recursive: true });
  prune(input.root);
  const staging = mkdtempSync(`${entry}.building-`);
  try { input.build(staging); writeFileSync(join(staging, markerName), `${JSON.stringify({ key: input.key })}\n`); }
  catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  if (existsSync(entry) && !usable()) {
    const aside = `${entry}.broken-${randomBytes(4).toString("hex")}`;
    try { renameSync(entry, aside); rmSync(aside, { recursive: true, force: true }); } catch { /* another process moved it first */ }
  }
  try { renameSync(staging, entry); }
  catch { /* another process renamed its build first, or the entry is in use and cannot be replaced */ }
  if (usable()) { rmSync(staging, { recursive: true, force: true }); return entry; }
  // The entry could not be placed: use this process's own build, removed when the process exits.
  process.on("exit", () => rmSync(staging, { recursive: true, force: true }));
  return staging;
}

function prune(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    try {
      const used = /\.(building|broken)-/.test(name) ? statSync(path).mtimeMs + day : statSync(join(path, markerName)).mtimeMs + 14 * day;
      if (used < Date.now()) rmSync(path, { recursive: true, force: true });
    } catch { /* an entry without a marker is a build in progress or already removed */ }
  }
}
