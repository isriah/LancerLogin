import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Runs before every dashboard and API workspace build (their prebuild scripts). An installation build must compose the
// official modules and the installation's plugins first; installation and update workflows from before LancerLogin 2.0
// do not, and would otherwise deploy a build that silently lacks them. Composition (scripts/compose-modules.mjs) writes
// .provision/module-migrations.json for this exact Core version; in CI without it, the build is refused before any
// migration or deployment. Local development builds are not affected. A development CI that deliberately builds
// without plugins sets LANCERLOGIN_PLUGIN_FREE_BUILD=1.
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const composedManifestPath = ".provision/module-migrations.json";
export const pluginFreeBuildVariable = "LANCERLOGIN_PLUGIN_FREE_BUILD";
const externalManifestsPath = "packages/shared/src/generated/external-manifests.ts";

export function continuousIntegration(env) {
  if (env.GITHUB_ACTIONS === "true") return true;
  const value = String(env.CI ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false";
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** Returns undefined when the build may proceed, otherwise the reason it is refused. */
export function compositionRefusal({ root = coreRoot, env = process.env } = {}) {
  if (!continuousIntegration(env)) return undefined;
  if (env[pluginFreeBuildVariable] === "1") return undefined;
  const official = readJson(join(root, "scripts/official-modules.json"));
  const officialCount = Array.isArray(official?.modules) ? official.modules.length : 0;
  const version = readJson(join(root, "package.json"))?.version;
  const staged = readJson(join(root, composedManifestPath));
  if (!staged) {
    // A release that pins no official module builds the same with or without composition.
    if (officialCount === 0) return undefined;
    return "module composition did not run";
  }
  if (staged.format !== 1 || staged.core?.version !== version || !Array.isArray(staged.modules)) return "the module composition record does not match this LancerLogin version";
  const manifests = existsSync(join(root, externalManifestsPath)) ? readFileSync(join(root, externalManifestsPath), "utf8") : "";
  for (const module of staged.modules) {
    const symbol = `module_${String(module?.id ?? "").replaceAll("-", "_")}`;
    if (!module?.id || !manifests.includes(symbol)) return `the composed module ${module?.id ?? "(unnamed)"} is missing from the generated module list`;
  }
  return undefined;
}

export function refusalMessage(reason, version) {
  return [
    `LancerLogin ${version ?? ""} build refused: ${reason}.`.replace("  ", " "),
    "This LancerLogin release composes its official modules and the installation's selected plugins before it is built.",
    "A CI build without composition usually means the installation workflow in your private deployment repository",
    "(.github/workflows/provision-template.yml or upgrade-web.yml) predates LancerLogin 2.0 and would deploy without them.",
    "Nothing was migrated or deployed. Update both workflows from the current LancerLogin template, then run the upgrade",
    "again, or update from Settings > Updates. See docs/MODULE-PLUGINS.md (Build with plugins).",
    `A development CI that deliberately builds without plugins sets ${pluginFreeBuildVariable}=1.`,
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const reason = compositionRefusal();
  if (reason) {
    console.error(refusalMessage(reason, readJson(join(coreRoot, "package.json"))?.version));
    process.exitCode = 1;
  }
}
