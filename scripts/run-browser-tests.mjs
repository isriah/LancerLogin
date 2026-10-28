import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { browserGroups, parsePart, partitionGroup, specsForGroup } from "./browser-groups.mjs";
import { prepareTestComposition, readTestSelection } from "./test-plugin-sources.mjs";

const workspace = process.cwd();
const seed = Number.parseInt(createHash("sha256").update(workspace).digest("hex").slice(0, 8), 16);
const portBase = 30_000 + (seed % 10_000) * 3;
const playwrightCli = join(workspace, "node_modules", "playwright", "cli.js");

// --compose-selection <file> composes a test plugin selection (file:// sources allowed) into this checkout before the run
// and restores the plugin-free defaults afterwards, so specs exercise the dashboard exactly as a composed build serves it.
// Public https pins are fetched anonymously; private ones need LANCERLOGIN_PLUGIN_TOKEN or a local plugin checkout (see test-plugin-sources.mjs).
//
// --group <core|plugin|integration> runs one release-gate group from tests-browser/groups.json (see browser-groups.mjs).
// core must run plugin-free; plugin and integration must run composed, so their plugin specs can never skip silently.
const takeOption = (args, name) => {
  const index = args.indexOf(name);
  if (index < 0) return { args, value: undefined };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  if (args.indexOf(name, index + 1) >= 0) throw new Error(`${name} may be given once`);
  return { args: args.filter((_, position) => position !== index && position !== index + 1), value };
};
const composeOption = takeOption(process.argv.slice(2), "--compose-selection");
const groupOption = takeOption(composeOption.args, "--group");
const selection = composeOption.value;
const group = groupOption.value;
if (group) {
  if (!Object.hasOwn(browserGroups, group)) throw new Error(`Unknown browser group ${group}; use ${Object.keys(browserGroups).join(", ")}`);
  if (browserGroups[group].composed && !selection) throw new Error(`The ${group} browser group runs composed; add --compose-selection tests/fixtures/carpool.modules.json`);
  if (!browserGroups[group].composed && selection) throw new Error(`The ${group} browser group runs plugin-free; remove --compose-selection`);
}
// --part i/n (with --group) runs one of n file-level parts balanced by measured seconds; the gate's shards use it.
const partOption = takeOption(groupOption.args, "--part");
if (partOption.value && !group) throw new Error("--part needs --group");
if (partOption.value && partOption.args.some((arg) => arg === "--shard" || arg.startsWith("--shard="))) throw new Error("--part replaces --shard; use one of them");
const groupSpecs = () => {
  if (!partOption.value) return specsForGroup(group, workspace);
  const { part, parts } = parsePart(partOption.value);
  return partitionGroup(group, parts, workspace)[part - 1].files;
};
const playwrightArgs = group ? [...partOption.args, ...groupSpecs()] : partOption.args;
const compose = (extra, env = process.env) => spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(workspace, "scripts", "compose-modules.mjs"), ...extra], { stdio: "inherit", env });
if (selection) {
  const { modules, officialModules } = readTestSelection(selection, workspace);
  const prepared = prepareTestComposition({ modules, officialModules, root: workspace });
  if (prepared.reason) {
    console.error(`Module composition is unavailable; no browser specs ran. ${prepared.reason}`);
    process.exit(1);
  }
  const status = compose(prepared.args, prepared.env).status;
  prepared.cleanup();
  if (status !== 0) {
    compose(["--restore"]);
    console.error("Module composition failed; no browser specs ran.");
    process.exit(1);
  }
}

const child = spawn(process.execPath, [playwrightCli, "test", ...playwrightArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    LANCERLOGIN_BROWSER_PORT_BASE: process.env.LANCERLOGIN_BROWSER_PORT_BASE ?? String(portBase),
    PWTEST_CACHE_DIR: process.env.PWTEST_CACHE_DIR ?? join(workspace, "node_modules", ".cache", "playwright-transform"),
  },
});

child.once("error", (error) => {
  if (selection) compose(["--restore"]);
  console.error(`Unable to start Playwright: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (selection) compose(["--restore"]);
  if (code !== 0) {
    console.error(`Playwright failed (exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}).`);
    process.exitCode = code ?? 1;
  }
});
