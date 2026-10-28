// Compose plugins for Core-side tests exactly as an installation build would, then point this process at the composed output.
// Composition runs in a child process with Core's official modules (scripts/official-modules.json, Outreach first) plus an
// optional test selection, so tests see the same module set an installation with that selection receives. Afterwards:
//   - Core's generated plugin lists resolve to the composed output, so application modules imported later include the plugins;
//   - `@lancerlogin/module-sdk` resolves to this Core's SDK, as composition guarantees for builds;
//   - `@lancerlogin-test/<alias>/<path>` resolves to a file in the composed checkout of the plugin with that alias.
// A process composes once: import one fixture (carpool-plugin.ts or outreach-plugin.ts) first, then import test bodies and
// application modules dynamically. When a plugin source is unavailable (for example a private plugin without
// LANCERLOGIN_PLUGIN_TOKEN or a local plugin checkout, or no network), `available` is false and callers register a skipped test that names the reason; the named environment switch fails instead.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const output = join(scratch, "output");
  mkdirSync(join(output, "apps/dashboard/src"), { recursive: true });
  writeFileSync(join(output, "apps/dashboard/src/module-contributions.ts"), "export type DashboardModuleContribution = unknown;\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(coreRoot, "scripts/compose-modules.mjs"), ...prepared.args, "--output-root", output, "--work-directory", join(scratch, "plugins")], { cwd: coreRoot, encoding: "utf8", env: prepared.env });
  if (result.status !== 0) {
    const remote = (prepared.modules as Pin[]).filter((pin) => pin.source.startsWith("https:")).map((pin) => unreachablePinAdvice(pin));
    throw new Error(`Plugin composition failed: ${result.stderr}${result.stdout}${remote.length ? `\n${remote.join("\n")}` : ""}`);
  }
  const modules = prepared.modules as Pin[];
  return { available: true, output, roots: Object.fromEntries(modules.map((pin) => [pin.id, join(scratch, "plugins", pin.id)])), modules };
}
