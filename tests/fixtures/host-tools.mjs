// Find the host tools that some tests run: a POSIX shell that can start node, and a tar that reads and writes archives
// at the host's absolute paths. Each finder returns { name, path, env, reason }: `path` is what to spawn (or null), `env`
// adds whatever PATH entry the probe needed, and `reason` says why nothing usable was found.
//
// Windows is the reason this exists. From PowerShell or cmd, `bash` resolves to the WSL launcher (System32 or
// WindowsApps bash.exe), which starts a Linux shell where the Windows node is not on PATH, so scripts fail with exit 127.
// From Git Bash, `tar` resolves to GNU tar, which reads `C:\...` as a remote host. So on Windows the shell is always Git
// for Windows' own bin/bash.exe or bin/sh.exe (its launchers put coreutils on PATH), never the WSL launcher, and tar is the
// first one that passes a real extract-and-create probe.
//
// Locally a missing tool skips the test with that reason. In CI (CI=true or GITHUB_ACTIONS=true) it fails instead, so a
// runner that loses its shell or tar is noticed rather than silently skipping coverage: pass `toolSkip(tool)` as the test's
// skip option and call `requireTool(tool)` at the start of the test.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const windows = process.platform === "win32";
export const inCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

const pathKey = (env) => Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
// Return env with `entry` first on PATH, keeping Windows' single "Path" key rather than adding a second one.
export function prependPath(env, entry) {
  const key = pathKey(env);
  return { ...env, [key]: env[key] ? `${entry}${delimiter}${env[key]}` : entry };
}

const output = (command, args) => {
  try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return ""; }
};
// The WSL launcher lives in System32 or WindowsApps; it can never run the Windows node.
const wslLauncher = (path) => /[\\/](?:system32|sysnative|windowsapps)[\\/]/i.test(path);

// Git for Windows install roots: from git itself (exec-path is <root>/mingw64/libexec/git-core, `where git` gives
// <root>/cmd/git.exe), then the standard install locations.
function gitForWindowsRoots() {
  const roots = [];
  const ancestors = (path) => { for (let directory = resolve(path), depth = 0; depth < 4; depth++, directory = dirname(directory)) roots.push(directory); };
  const execPath = output("git", ["--exec-path"]);
  if (execPath) ancestors(execPath);
  for (const git of output("where.exe", ["git"]).split(/\r?\n/).filter(Boolean)) ancestors(dirname(git));
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) if (base) roots.push(join(base, "Git"));
  return [...new Set(roots)];
}

function shellCandidates(name) {
  if (!windows) return [name];
  const candidates = [];
  for (const root of gitForWindowsRoots()) for (const relative of [["bin", `${name}.exe`], ["usr", "bin", `${name}.exe`]]) {
    const candidate = join(root, ...relative);
    if (existsSync(candidate)) candidates.push(candidate);
  }
  // Another bash on PATH (MSYS2, Cygwin) is acceptable, but never the WSL launcher.
  for (const found of output("where.exe", [name]).split(/\r?\n/).filter(Boolean)) if (!wslLauncher(found)) candidates.push(found);
  return [...new Set(candidates)];
}

/**
 * Find a POSIX shell (`bash` or `sh`) whose scripts can run `node`, probed with the environment the test will pass.
 * @param {"bash" | "sh"} name
 * @param {NodeJS.ProcessEnv} [env]
 */
export function findShell(name = "bash", env = process.env) {
  const tried = [];
  for (const candidate of shellCandidates(name)) {
    const probe = (environment) => spawnSync(candidate, ["-c", "command -v node"], { env: environment, encoding: "utf8", windowsHide: true, timeout: 20_000 });
    if (probe(env).status === 0) return { name, path: candidate, env: (extra = {}) => ({ ...env, ...extra }), reason: "" };
    // The shell runs but cannot see node: put this node's directory first on PATH, as long as that makes it work.
    const withNode = prependPath(env, dirname(process.execPath));
    const second = probe(withNode);
    if (second.status === 0) return { name, path: candidate, env: (extra = {}) => ({ ...withNode, ...extra }), reason: "" };
    tried.push(`${candidate} (${second.error ? second.error.code : `exit ${second.status}`})`);
  }
  const where = windows ? "Git for Windows' bin/" + name + ".exe (the WSL launcher is never used)" : `${name} on PATH`;
  return { name, path: null, env: () => env, reason: tried.length ? `no ${name} that can run node: tried ${tried.join(", ")}` : `${name} not found; install ${where}` };
}

/** Find bash with GNU date (`date -d`), which the workflow's credential-expiry parsing needs. */
export function findGnuDateBash(env = process.env) {
  const bash = findShell("bash", env);
  if (!bash.path) return { ...bash, name: "bash with GNU date" };
  const result = spawnSync(bash.path, ["-c", "date -u -d '2026-11-05 00:00:00 UTC' +%Y"], { env: bash.env(), encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.stdout?.trim() === "2026") return { ...bash, name: "bash with GNU date" };
  return { name: "bash with GNU date", path: null, env: bash.env, reason: `${bash.path} has no GNU date (date -d failed)` };
}

// One empty-file archive, gzip-compressed; built here so the probe does not need a working tar to make it.
function probeArchive() {
  const header = Buffer.alloc(512);
  header.write("probe.txt", 0); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write("00000000000\0", 124); header.write("00000000000\0", 136); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
  header.fill(32, 148, 156);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
}

// The commands scripts/package-kiosk.mjs and the kiosk artifact tests run, at absolute host paths.
function tarWorks(command, env) {
  const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-tar-probe-"));
  try {
    const archive = join(scratch, "probe.tar.gz"); const extracted = join(scratch, "out");
    writeFileSync(archive, probeArchive()); mkdirSync(extracted);
    const options = { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 20_000 };
    const extract = spawnSync(command, ["-xzf", archive, "-C", extracted], options);
    if (extract.status !== 0 || !existsSync(join(extracted, "probe.txt"))) return `extract failed: ${String(extract.stderr ?? extract.error?.code ?? "").trim().split(/\r?\n/)[0]}`;
    const create = spawnSync(command, ["--format=ustar", "-cf", "-", "-C", extracted, "."], options);
    if (create.status !== 0 || !create.stdout?.length) return `create failed: ${String(create.stderr ?? create.error?.code ?? "").trim().split(/\r?\n/)[0]}`;
    return "";
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/**
 * Find a tar that extracts and creates archives at absolute host paths. `env` puts it first on PATH, for code such as
 * scripts/package-kiosk.mjs that runs plain `tar`; `pathEntry` is that directory, or "" when PATH's tar already works.
 */
export function findTar(env = process.env) {
  const failure = tarWorks("tar", env);
  if (!failure) return { name: "tar", path: "tar", pathEntry: "", env: (extra = {}) => ({ ...env, ...extra }), reason: "" };
  const tried = [`tar on PATH (${failure})`];
  // Windows ships bsdtar, which accepts drive-letter paths; Git Bash puts GNU tar, which does not, ahead of it on PATH.
  const system = windows && process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "tar.exe") : "";
  if (system && existsSync(system)) {
    const withSystem = prependPath(env, dirname(system));
    const systemFailure = tarWorks(system, withSystem);
    if (!systemFailure) return { name: "tar", path: system, pathEntry: dirname(system), env: (extra = {}) => ({ ...withSystem, ...extra }), reason: "" };
    tried.push(`${system} (${systemFailure})`);
  }
  return { name: "tar", path: null, pathEntry: "", env: () => env, reason: `no tar that handles absolute host paths: tried ${tried.join(", ")}` };
}

/** The test's skip option: the reason locally, false in CI so that requireTool fails the test instead. */
export const toolSkip = (tool) => !tool.path && !inCI && `${tool.name} is not available: ${tool.reason}`;

/** Fail with the reason when the tool is missing (reached only in CI, where toolSkip does not skip); return its path. */
export function requireTool(tool) {
  assert.ok(tool.path, `${tool.name} is required in CI: ${tool.reason}`);
  return tool.path;
}
