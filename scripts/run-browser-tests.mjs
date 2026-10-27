import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { prepareTestComposition, readTestSelection } from "./test-plugin-sources.mjs";

const workspace = process.cwd();
const seed = Number.parseInt(createHash("sha256").update(workspace).digest("hex").slice(0, 8), 16);
const portBase = 30_000 + (seed % 10_000) * 3;
const playwrightCli = join(workspace, "node_modules", "playwright", "cli.js");

// --compose-selection <file> composes a test plugin selection (file:// sources allowed) into this checkout before the run
// and restores the plugin-free defaults afterwards, so specs exercise the dashboard exactly as a composed build serves it.
// Private https pins need LANCERLOGIN_PLUGIN_TOKEN or a local plugin checkout (see test-plugin-sources.mjs).
const args = process.argv.slice(2);
const selectionIndex = args.indexOf("--compose-selection");
const selection = selectionIndex >= 0 ? args[selectionIndex + 1] : undefined;
if (selectionIndex >= 0 && (!selection || selection.startsWith("--"))) throw new Error("--compose-selection needs a selection file");
const playwrightArgs = selectionIndex >= 0 ? args.filter((_, index) => index !== selectionIndex && index !== selectionIndex + 1) : args;
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
