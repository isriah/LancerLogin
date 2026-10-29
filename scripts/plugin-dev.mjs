#!/usr/bin/env node
// Local plugin development: compose a plugin from a folder on this computer into this Core checkout and run it.
//
//   npm run plugins:dev -- --plugin <folder> [--plugin <folder>] [--no-official-modules] [--no-watch] [--api-port 8787] [--dashboard-port 5173]
//   npm run plugins:dev -- --restore
//
// Development only. Each run takes a snapshot of the plugin folder (its git-tracked and untracked, not ignored files, or
// every file outside .git and node_modules), commits the snapshot to a throwaway repository under
// .provision/plugin-dev/sources, and composes that exact commit with scripts/compose-modules.mjs. A local plugin
// therefore passes exactly the checks a pinned plugin does: package, contract and Core range, imports, peer
// dependencies, locked dependency install, manifest, API shape, migrations and conflicts with every other module.
// Core's official modules are composed too, unless --no-official-modules is given.
//
// It then applies Core's D1 migrations to a local database under .provision/plugin-dev/state, starts the Worker with
// wrangler dev and the dashboard with Vite, and recomposes when a plugin file changes (unless --no-watch). Plugin
// migrations are applied by the Worker itself, as in a deployment. Ctrl+C stops both servers and restores the generated
// module files to their committed plugin-free defaults.
//
// Guards. This mode is separate from installation builds: provisioning, web updates (scripts/run-web-upgrade.mjs),
// dashboard plugin management and every lancerlogin.modules.json accept only https sources pinned to a full commit, so a
// local folder can never be selected there. This script refuses to run when CI or deployment markers are present, never
// reads a selection file, and marks every generated file it writes as a local development composition.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CompositionError, composeModules, compositionEnvironment, generatedFiles, moduleDataFile, restoreModuleDefaults, runCommand } from "./compose-modules.mjs";
import { isolatedGitEnv } from "./git-env.mjs";

export const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Everything this mode writes, apart from the generated module files, lives here. .provision/ is ignored by git. */
export const stateDirectoryName = ".provision/plugin-dev";
/** The first line of every generated file a local composition writes, so a stray diff explains itself. */
export const localDevelopmentHeader = "// LOCAL PLUGIN DEVELOPMENT composition written by npm run plugins:dev. Do not commit or deploy; restore with npm run plugins:dev -- --restore.";

/**
 * Environment variables that mean this is not a developer's own computer: CI systems, Cloudflare builds, and the
 * credentials and installation variables that provisioning and web updates run with.
 */
export const refusedEnvironmentMarkers = Object.freeze([
  "CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "TF_BUILD", "JENKINS_URL", "CF_PAGES", "WORKERS_CI",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "INSTALLATION_SLUG", "LANCERLOGIN_MODULE_SELECTION_TOKEN", "WEB_UPDATE_TOKEN",
]);

export class PluginDevelopmentError extends Error {
  constructor(message) { super(message); this.name = "PluginDevelopmentError"; }
}
const fail = (message) => { throw new PluginDevelopmentError(message); };
const moduleIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const posixPath = (path) => path.split(sep).join("/");
const inside = (root, target) => { const path = relative(resolve(root), resolve(target)); return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };

/** The reason local plugin development must not run in this environment, or undefined on a developer's computer. */
export function developmentEnvironmentRefusal(env = process.env) {
  const present = refusedEnvironmentMarkers.filter((name) => typeof env[name] === "string" && env[name] !== "" && env[name] !== "0" && env[name].toLowerCase() !== "false");
  if (!present.length) return undefined;
  return `Local plugin development runs only on a developer's computer, and ${present.join(", ")} ${present.length === 1 ? "is" : "are"} set. It is never part of CI, provisioning or web updates; unset ${present.length === 1 ? "it" : "them"} in a local shell to continue.`;
}

/** Read a local plugin folder's package.json far enough to name its module. Composition validates everything else. */
export async function readLocalPlugin(directory) {
  const root = resolve(directory);
  let stats;
  try { stats = await lstat(root); } catch { fail(`Plugin folder ${directory} does not exist`); }
  if (!stats.isDirectory()) fail(`Plugin folder ${directory} is not a directory`);
  let pkg;
  try { pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { fail(`Plugin folder ${directory} has no readable package.json`); }
  const moduleId = pkg?.lancerlogin?.moduleId;
  if (typeof moduleId !== "string" || !moduleIdPattern.test(moduleId) || moduleId.length > 64) fail(`Plugin folder ${directory} package.json has no valid lancerlogin.moduleId`);
  return { directory: root, moduleId };
}

const gitOutput = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: isolatedGitEnv() });

/** Files to snapshot, relative to the plugin root: git's view when the folder is in a work tree, otherwise a walk. */
export async function localPluginFiles(root) {
  const inWorkTree = gitOutput(root, ["rev-parse", "--is-inside-work-tree"]);
  let files;
  if (inWorkTree.status === 0 && inWorkTree.stdout.trim() === "true") {
    const listed = gitOutput(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]);
    if (listed.status !== 0) fail(`git could not list the files of ${root}: ${listed.stderr.trim()}`);
    // Tracked files deleted in the working tree are not part of the snapshot.
    files = [...new Set(listed.stdout.split("\0").filter(Boolean))].filter((name) => existsSync(join(root, name)));
  } else {
    files = [];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path); else files.push(posixPath(relative(root, path)));
      }
    };
    await walk(root);
  }
  files = files.filter((name) => !name.split("/").some((segment) => segment === "node_modules" || segment === ".git")).sort();
  for (const name of files) {
    const path = join(root, name);
    if (!inside(root, path)) fail(`Plugin file ${name} is outside the plugin folder`);
    if ((await lstat(path)).isSymbolicLink()) fail(`Plugin contains a symbolic link: ${name}. Composition does not accept symbolic links.`);
  }
  if (!files.includes("package.json")) fail(`Plugin folder ${root} has no package.json at its root`);
  return files;
}

/**
 * Commit a snapshot of a local plugin folder to a throwaway repository and return its file:// source and commit, which
 * composition then fetches and checks like any pinned plugin. The repository belongs to this tool: it has no hooks and
 * its commits are never signed or pushed.
 */
export async function snapshotLocalPlugin({ plugin, sourcesDirectory, run = runCommand }) {
  const destination = join(sourcesDirectory, plugin.moduleId);
  const files = await localPluginFiles(plugin.directory);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const name of files) {
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(plugin.directory, name), target);
  }
  const hooks = join(sourcesDirectory, ".no-hooks");
  await mkdir(hooks, { recursive: true });
  const env = { ...snapshotEnvironment(process.env), GIT_AUTHOR_NAME: "LancerLogin plugin development", GIT_AUTHOR_EMAIL: "plugin-dev@localhost.invalid", GIT_COMMITTER_NAME: "LancerLogin plugin development", GIT_COMMITTER_EMAIL: "plugin-dev@localhost.invalid" };
  const options = { cwd: destination, env };
  const config = ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false"];
  await run("git", ["init", "--quiet", "--template=", destination], options);
  await run("git", ["-C", destination, ...config, "add", "-A"], options);
  await run("git", ["-C", destination, ...config, "commit", "--quiet", "--allow-empty", "-m", `Local snapshot of ${plugin.moduleId}`], options);
  const commit = (await run("git", ["-C", destination, "rev-parse", "HEAD"], options)).stdout.trim();
  return { id: plugin.moduleId, source: pathToFileURL(destination).href, commit };
}

const snapshotEnvironment = (env) => Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === "string" && ["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "WINDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"].includes(name.toUpperCase())));

/** Plugin composition never sees credentials; only the optional plugin token passes, with compose-modules.mjs's filter. */
export { compositionEnvironment };

/** Mark generated files written by a local composition. Returns the paths it marked. */
export async function markLocalComposition(outputRoot) {
  const marked = [];
  for (const path of [...Object.values(generatedFiles).map((file) => file.path), moduleDataFile]) {
    const file = join(outputRoot, path);
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    if (!text.startsWith("// Generated by scripts/compose-modules.mjs")) continue;
    const newline = text.indexOf("\n");
    await writeFile(file, `${localDevelopmentHeader}${text.slice(newline > 0 && text[newline - 1] === "\r" ? newline - 1 : newline)}`);
    marked.push(path);
  }
  return marked;
}

/**
 * Compose local plugin folders (plus Core's official modules unless officialModules is false) into outputRoot. The
 * selection that composition reads is written inside the state directory and names only snapshot commits.
 */
export async function composeLocalPlugins({ plugins, officialModules = true, outputRoot = coreRoot, stateDirectory = join(outputRoot, stateDirectoryName), env = process.env, log = (line) => console.log(line), run } = {}) {
  const refusal = developmentEnvironmentRefusal(env);
  if (refusal) fail(refusal);
  if (!plugins?.length) fail("Name at least one plugin folder with --plugin <folder>");
  const resolved = [];
  for (const directory of plugins) resolved.push(await readLocalPlugin(directory));
  const ids = resolved.map((plugin) => plugin.moduleId);
  if (new Set(ids).size !== ids.length) fail(`Two plugin folders declare the same module ID: ${ids.find((id, index) => ids.indexOf(id) !== index)}`);
  for (const plugin of resolved) if (inside(plugin.directory, outputRoot)) fail(`Plugin folder ${plugin.directory} contains the Core checkout; use the plugin's own folder`);
  const sourcesDirectory = join(stateDirectory, "sources");
  const modules = [];
  for (const plugin of resolved) {
    const pin = await snapshotLocalPlugin({ plugin, sourcesDirectory, run });
    log(`Snapshot of ${posixPath(relative(process.cwd(), plugin.directory)) || "."} committed as ${pin.commit} for module ${pin.id}`);
    modules.push(pin);
  }
  const selectionPath = join(stateDirectory, "plugin-dev.selection.json");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(selectionPath, `${JSON.stringify({ format: 1, modules }, null, 2)}\n`);
  const result = await composeModules({
    selectionPath, outputRoot, officialModules, allowFileSources: true,
    workDirectory: join(stateDirectory, "plugins"), env: compositionEnvironment(env), log, runCommand: run,
  });
  await markLocalComposition(outputRoot);
  return { ...result, local: modules };
}

/** Values for the local Worker: generated once per checkout and kept in the ignored state directory. */
export async function developmentRuntime({ stateDirectory, apiPort = 8787, dashboardPort = 5173, root = coreRoot }) {
  await mkdir(stateDirectory, { recursive: true });
  const varsPath = join(stateDirectory, ".dev.vars");
  const codePath = join(stateDirectory, "setup-code.txt");
  if (!existsSync(varsPath) || !existsSync(codePath)) {
    const key = () => randomBytes(32).toString("base64url");
    const setupCode = randomBytes(12).toString("base64url");
    const hash = createHash("sha256").update(setupCode).digest("base64url");
    await writeFile(codePath, `${setupCode}\n`, { mode: 0o600 });
    await writeFile(varsPath, `# Local plugin development only. Generated by npm run plugins:dev.\nSESSION_KEY=${key()}\nINTEGRATION_KEY=${key()}\nFINGERPRINT_VAULT_KEY=${key()}\nBOOTSTRAP_CODE_HASH=${hash}\n`, { mode: 0o600 });
  }
  const configPath = join(stateDirectory, "wrangler.json");
  const relativeToState = (path) => posixPath(relative(stateDirectory, join(root, path)));
  const config = {
    name: "lancerlogin-plugin-dev",
    main: relativeToState("apps/api/src/index.ts"),
    compatibility_date: "2026-08-01",
    // DEFAULT_THEME keeps local previews on the purple development palette so they are easy to tell from releases.
    vars: { APP_MODE: "configured", ALLOWED_ORIGIN: `http://localhost:${dashboardPort}`, DEFAULT_THEME: "development" },
    triggers: { crons: ["*/5 * * * *"] },
    d1_databases: [{ binding: "DB", database_name: "lancerlogin-plugin-dev", database_id: "00000000-0000-4000-8000-00000000d0e1", migrations_dir: relativeToState("apps/api/migrations") }],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, persistDirectory: join(stateDirectory, "state"), setupCode: readFileSync(codePath, "utf8").trim(), apiUrl: `http://localhost:${apiPort}`, dashboardUrl: `http://localhost:${dashboardPort}`, apiPort, dashboardPort };
}

const activeMarker = (stateDirectory) => join(stateDirectory, "active.json");
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } };

/** Restore the plugin-free defaults left by a local composition, unless another plugins:dev session is running. */
export async function restoreLocalComposition({ outputRoot = coreRoot, stateDirectory = join(outputRoot, stateDirectoryName) } = {}) {
  const marker = activeMarker(stateDirectory);
  if (existsSync(marker)) {
    let pid;
    try { pid = JSON.parse(readFileSync(marker, "utf8")).pid; } catch { pid = undefined; }
    if (Number.isSafeInteger(pid) && pid !== process.pid && processAlive(pid)) fail(`Another npm run plugins:dev session (process ${pid}) is using this checkout. Stop it first.`);
  }
  const written = await restoreModuleDefaults({ outputRoot });
  rmSync(marker, { force: true });
  return written;
}

function parseArguments(argv) {
  const options = { plugins: [], officialModules: true, watch: true, apiPort: 8787, dashboardPort: 5173, restore: false };
  const port = (argument, text) => { const value = Number(text); if (!Number.isInteger(value) || value < 1024 || value > 65535) fail(`${argument} must be a port from 1024 to 65535`); return value; };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => { const next = argv[++index]; if (!next || next.startsWith("--")) fail(`${argument} needs a value`); return next; };
    if (argument === "--plugin") options.plugins.push(value());
    else if (argument === "--no-official-modules") options.officialModules = false;
    else if (argument === "--no-watch") options.watch = false;
    else if (argument === "--api-port") options.apiPort = port(argument, value());
    else if (argument === "--dashboard-port") options.dashboardPort = port(argument, value());
    else if (argument === "--restore") options.restore = true;
    else fail(`Unknown argument ${argument}. Use --plugin <folder> [--no-official-modules] [--no-watch] [--api-port N] [--dashboard-port N], or --restore.`);
  }
  if (options.restore && options.plugins.length) fail("--restore takes no other arguments");
  if (!options.restore && !options.plugins.length) fail("Name the plugin folder with --plugin <folder>");
  if (options.apiPort === options.dashboardPort) fail("--api-port and --dashboard-port must differ");
  return options;
}

const childEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(CLOUDFLARE|TOKEN|SECRET|PASSWORD|_KEY$|_CODE$|^GITHUB_)/i.test(name)));

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const stateDirectory = join(coreRoot, stateDirectoryName);
  if (options.restore) {
    const written = await restoreLocalComposition({ stateDirectory });
    console.log(written.length ? `Restored ${written.join(", ")}` : "Generated module files already match their committed defaults.");
    return;
  }
  const refusal = developmentEnvironmentRefusal(process.env);
  if (refusal) fail(refusal);
  // A previous session that was killed may have left its composition behind; restore it before starting.
  await restoreLocalComposition({ stateDirectory });
  await mkdir(stateDirectory, { recursive: true });
  writeFileSync(activeMarker(stateDirectory), JSON.stringify({ pid: process.pid }));

  const children = [];
  let restored = false;
  const restoreSync = () => {
    if (restored) return;
    restored = true;
    for (const child of children) stopChild(child);
    // Synchronous, so it also runs from the exit handler.
    spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(coreRoot, "scripts/compose-modules.mjs"), "--restore"], { stdio: "inherit", cwd: coreRoot });
    rmSync(activeMarker(stateDirectory), { force: true });
  };
  process.on("exit", restoreSync);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { console.log("\nStopping local plugin development and restoring the plugin-free generated files."); restoreSync(); process.exit(130); });

  const compose = () => composeLocalPlugins({ plugins: options.plugins, officialModules: options.officialModules, stateDirectory, env: process.env });
  const result = await compose();
  console.log(`Composed ${result.modules.join(", ")} for local development. Generated module files are marked as a local composition and are restored when this command stops.`);

  const runtime = await developmentRuntime({ stateDirectory, apiPort: options.apiPort, dashboardPort: options.dashboardPort });
  const wrangler = join(coreRoot, "node_modules/wrangler/bin/wrangler.js");
  const vite = join(coreRoot, "node_modules/vite/bin/vite.js");
  const env = { ...childEnvironment(), WRANGLER_SEND_METRICS: "false" };
  const migrate = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "lancerlogin-plugin-dev", "--local", "--config", runtime.configPath, "--persist-to", runtime.persistDirectory], { stdio: "inherit", cwd: coreRoot, env: { ...env, CI: "true" } });
  if (migrate.status !== 0) fail("Applying Core migrations to the local database failed");

  children.push(spawn(process.execPath, [wrangler, "dev", "--local", "--config", runtime.configPath, "--persist-to", runtime.persistDirectory, "--port", String(runtime.apiPort), "--ip", "localhost", "--test-scheduled"], { stdio: "inherit", cwd: coreRoot, env }));
  children.push(spawn(process.execPath, [vite, "--host", "localhost", "--port", String(runtime.dashboardPort), "--strictPort"], { stdio: "inherit", cwd: join(coreRoot, "apps/dashboard"), env: { ...env, VITE_API_BASE_URL: runtime.apiUrl } }));
  for (const child of children) child.once("exit", (code) => { if (!restored) { console.error(`A development server stopped (exit ${code}). Stopping.`); restoreSync(); process.exit(1); } });

  console.log([
    "",
    `Dashboard: ${runtime.dashboardUrl}    Worker: ${runtime.apiUrl}`,
    `First-Admin setup code for this local database: ${runtime.setupCode}`,
    `Run scheduled jobs: ${runtime.apiUrl}/__scheduled?cron=*/5+*+*+*+*`,
    options.watch ? "Watching the plugin folders; saving a file recomposes. Ctrl+C stops and restores the generated files." : "Ctrl+C stops and restores the generated files.",
    "",
  ].join("\n"));

  if (!options.watch) return;
  let timer; let composing = false; let again = false;
  const recompose = async () => {
    if (composing) { again = true; return; }
    composing = true;
    try { const next = await compose(); console.log(`Recomposed ${next.modules.join(", ")}.`); }
    catch (error) { console.error(`Recomposition failed; fix the plugin and save again. ${error instanceof Error ? error.message : String(error)}`); }
    finally { composing = false; if (again) { again = false; schedule(); } }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(recompose, 400); };
  for (const directory of options.plugins) {
    watch(resolve(directory), { recursive: true }, (_event, name) => {
      const path = posixPath(String(name ?? ""));
      if (path.split("/").some((segment) => segment === "node_modules" || segment === ".git")) return;
      schedule();
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const known = error instanceof PluginDevelopmentError || error instanceof CompositionError;
    console.error(`Local plugin development failed: ${known ? error.message : error?.stack ?? String(error)}`);
    process.exitCode = 1;
    process.exit(1);
  });
}
