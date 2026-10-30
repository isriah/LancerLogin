#!/usr/bin/env node
// Local update rehearsal: upgrade a synthetic installation from one LancerLogin release to a candidate, entirely on this
// computer.
//
//   npm run rehearse:update -- --from <ref> --to <ref> [--target-tag vX.Y.Z] [--selection <file>] [--report <file>]
//                              [--work-dir <empty folder>] [--keep]
//
// A ref is a tag, branch, remote-tracking branch or commit. A release tag (v1.2.3, v2.0.0-beta.12) or public:<ref> is
// fetched from the public LancerLogin repository; any other ref, or private:<ref>, is resolved in this repository after
// fetching it from origin when it is a remote-tracking branch or an unknown commit.
//
// What it does, in order, with every step recorded in the report:
//  1. Exports both trees with git archive into a new temporary folder, installs each with npm ci --no-audit (npm's own
//     download cache is the only thing shared), and composes the official modules plus the plugin selection (default:
//     tests/fixtures/carpool.modules.json, Carpool pinned to its released commit) with each tree's own composer.
//  2. Builds FROM's Worker bundle with wrangler deploy --dry-run, applies FROM's migrations to a local D1 database with
//     wrangler d1 migrations apply --local, runs the Worker in Miniflare against that database and seeds synthetic data
//     through the API: first Admin, roster, meetings, attendance, module enablement and setup, Outreach labels, teams,
//     activities and entries, a Carpool plan with participants and a paired synthetic kiosk.
//  3. Snapshots every table, then runs TO's updater sequence (executeWebUpgrade from TO's run-web-upgrade.mjs) with a
//     local adapter: TO's migration policy (validateMigrationPolicy), first-party module check, plugin composition and
//     extracted-module guard, the build in CI mode (so scripts/check-module-composition.mjs runs), a checkpoint copy of
//     the database, wrangler d1 migrations apply --local, the fingerprint storage key step, the API Worker and the Pages
//     proxy (the generated _worker.js) in Miniflare, and TO's post-deployment health predicate. It first proves the
//     refusal path: a selection without Carpool must stop with module_migration_required before any change.
//  4. Verifies preserved data, the plugin catalog and migration ledger, Outreach and Carpool endpoints, sessions and
//     sign-in, the kiosk roster and its revision, and the Pages proxy including the //host escape check, then runs TO's
//     no-cloud updater tests.
//
// Guarantees: no GitHub repository, secret, Cloudflare account, deployment or device is used. Wrangler runs with an
// empty home, no credentials and a loopback-only Cloudflare API origin; the Workers run in Miniflare with every outbound
// request refused and recorded. Plugin composition fetches the pinned public plugin commits anonymously. All data is
// synthetic. The temporary folder is removed at the end unless --keep is given; links inside it (npm workspace
// junctions) are removed first without following them.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isolatedGitEnv } from "./git-env.mjs";

export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const publicRepository = "https://github.com/isriah/LancerLogin.git";
export const defaultSelection = "tests/fixtures/carpool.modules.json";
const slug = "rehearsal";
const databaseId = "00000000-0000-4000-8000-0000000d1e01";
const apiOrigin = `https://${slug}-api.rehearsal.workers.dev`;
const dashboardOrigin = `https://${slug}-dashboard.pages.dev`;
const timeZone = "UTC";

export class RehearsalError extends Error {}
const fail = (message) => { throw new RehearsalError(message); };

// ---------------------------------------------------------------------------------------------------------------------
// Arguments and refs

export function parseArguments(argv) {
  const options = { keep: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => { const next = argv[++index]; if (!next || next.startsWith("--")) fail(`${argument} needs a value`); return next; };
    if (argument === "--from") options.from = value();
    else if (argument === "--to") options.to = value();
    else if (argument === "--target-tag") options.targetTag = value();
    else if (argument === "--selection") options.selection = value();
    else if (argument === "--report") options.report = value();
    else if (argument === "--work-dir") options.workDir = value();
    else if (argument === "--keep") options.keep = true;
    else fail(`Unknown argument ${argument}. Use --from <ref> --to <ref> [--target-tag vX.Y.Z] [--selection <file>] [--report <file>] [--work-dir <folder>] [--keep].`);
  }
  if (!options.from || !options.to) fail("Name both trees: --from <ref> --to <ref>");
  if (options.targetTag && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.targetTag)) fail("--target-tag must look like v2.0.0-beta.13");
  return options;
}

const releaseTagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** Where a ref comes from: release tags and public: refs from the public repository, everything else from this one. */
export function refSource(ref) {
  if (ref.startsWith("public:")) return { repository: "public", name: ref.slice(7) };
  if (ref.startsWith("private:")) return { repository: "private", name: ref.slice(8) };
  return { repository: releaseTagPattern.test(ref) ? "public" : "private", name: ref };
}

function git(args, { cwd = toolRoot, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: isolatedGitEnv(), windowsHide: true });
  if (result.status !== 0 && !allowFailure) fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function resolveRef(ref) {
  const { repository, name } = refSource(ref);
  if (repository === "public") {
    const remoteRef = releaseTagPattern.test(name) ? `refs/tags/${name}` : name;
    git(["fetch", "--quiet", "--no-tags", publicRepository, remoteRef]);
    return { ref, repository, sha: git(["rev-parse", "FETCH_HEAD^{commit}"]) };
  }
  const tracking = /^origin\/(.+)$/.exec(name);
  if (tracking) git(["fetch", "--quiet", "origin", tracking[1]]);
  let sha = git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { allowFailure: true });
  if (!sha && /^[0-9a-f]{7,40}$/.test(name)) { git(["fetch", "--quiet", "origin", name]); sha = git(["rev-parse", "--verify", `${name}^{commit}`]); }
  if (!sha) fail(`Cannot resolve ${ref} in this repository`);
  return { ref, repository, sha };
}

// ---------------------------------------------------------------------------------------------------------------------
// Processes, files and cleanup

/** Environment for every child: no credentials, no git repository variables. */
export function childEnvironment(env = process.env) {
  return isolatedGitEnv(Object.fromEntries(Object.entries(env).filter(([name]) => !/(CLOUDFLARE|TOKEN|SECRET|PASSWORD|_KEY$|_CODE$|^GITHUB_|^CI$|^LANCERLOGIN_)/i.test(name))));
}

/** Wrangler runs with an empty home, no credentials, no update check and a loopback-only Cloudflare API origin. */
export function wranglerEnvironment(home) {
  return { ...childEnvironment(), CI: "true", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, WRANGLER_HOME: home,
    WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true", WRANGLER_HIDE_BANNER: "true",
    CLOUDFLARE_API_BASE_URL: "http://127.0.0.1:1" };
}

/** npm's own CLI script, run with this Node, so no shell is involved. */
export function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  const found = candidates.find((path) => path && /npm-cli\.js$/.test(path) && existsSync(path));
  if (!found) fail("Cannot find npm-cli.js beside this Node");
  return found;
}

function run(command, args, { cwd, env, log, timeout = 900_000, input } = {}) {
  if (command === "npm") { args = [npmCli(), ...args]; command = process.execPath; }
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let output = "";
    const append = (data) => { output += data; if (output.length > 4_000_000) output = output.slice(-2_000_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const timer = setTimeout(() => { output += "\n[rehearsal: timed out]"; stopTree(child); }, timeout);
    child.on("error", (error) => { clearTimeout(timer); done({ status: -1, output: `${output}\n${error.message}` }); });
    child.on("close", (status) => { clearTimeout(timer); log?.(`$ ${[command, ...args].join(" ")} (exit ${status})\n${output}`); done({ status, output }); });
    if (input !== undefined) child.stdin.end(input);
  });
}
async function mustRun(label, command, args, options) {
  const result = await run(command, args, options);
  if (result.status !== 0) fail(`${label} failed (exit ${result.status}): ${result.output.trim().split("\n").slice(-15).join("\n")}`);
  return result.output;
}
function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

/**
 * Remove a folder this run created. Every symbolic link or junction inside it is unlinked first without being followed,
 * so a workspace link can never lead the removal outside the folder; only then are the remaining files removed.
 */
export async function removeTree(root) {
  const unlinkLinks = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        // Windows junctions and directory links are removed with rmdir on the link itself, never its target.
        try { await unlink(path); } catch { await rmdir(path); }
      } else if (stats.isDirectory()) await unlinkLinks(path);
    }
  };
  await unlinkLinks(root);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function extractTree(sha, destination, archiveDirectory) {
  await mkdir(destination, { recursive: true });
  const archive = join(archiveDirectory, `${sha}.tar`);
  git(["archive", "--format=tar", "-o", archive, sha]);
  // Windows' own bsdtar: a GNU tar earlier on PATH (Git Bash) reads "C:" in a path as a remote host.
  const windowsTar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe") : undefined;
  const tar = spawnSync(windowsTar && existsSync(windowsTar) ? windowsTar : "tar", ["-xf", archive, "-C", destination], { encoding: "utf8", windowsHide: true });
  if (tar.status !== 0) fail(`Extracting ${sha} failed: ${tar.stderr}`);
  await rm(archive, { force: true });
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const importFrom = (tree, path) => import(pathToFileURL(join(tree, path)).href);

// ---------------------------------------------------------------------------------------------------------------------
// Local D1

/** The SQLite file Miniflare and wrangler keep for the database (resourcePersistencePath/d1/miniflare-D1DatabaseObject). */
export async function databaseFile(stateDirectory) {
  const directory = join(stateDirectory, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = existsSync(directory) ? (await readdir(directory)).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite") : [];
  if (files.length !== 1) fail(`Expected one local D1 database in ${directory}, found ${files.length}`);
  return join(directory, files[0]);
}
function openDatabase(path, readOnly = true) { return new DatabaseSync(path, { readOnly }); }
export function query(path, sql, params = []) {
  const db = openDatabase(path);
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
const userTables = (path) => query(path, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").map((row) => row.name);

/** Columns compared before and after the update. Only columns that exist in both snapshots are compared. */
export const keyRecords = Object.freeze({
  users: ["id", "local_username", "role", "active", "member_id"],
  members: ["id", "external_id", "first_name", "last_name", "email", "active"],
  meetings: ["id", "title", "starts_at", "ends_at", "required", "deleted_at", "series_id"],
  attendance_events: ["id", "member_id", "meeting_id", "action", "source", "occurred_at", "kiosk_event_id"],
  attendance_corrections: ["id", "member_id", "meeting_id", "disposition"],
  kiosks: ["id", "name", "active", "token_hash", "pairing_code_id"],
  organization_settings: ["installation_id", "organization_name", "time_zone", "late_scan_minutes"],
  platform_modules: ["module_id", "phase", "generation", "setup_complete"],
  platform_module_catalog: ["module_id", "origin", "source", "source_commit", "installed"],
  platform_module_migrations: ["module_id", "sequence", "name"],
  hours_labels: ["id", "name", "archived"],
  hours_teams: ["id", "name", "number", "program"],
  hours_activities: ["id", "title", "mode", "service_date", "team_id"],
  hours_activity_labels: ["activity_id", "label_id"],
  hours_entries: ["id", "member_id", "activity_id", "service_date", "duration_minutes", "status"],
  carpool_plans: ["id", "title", "destination", "archived"],
  carpool_people: ["id", "plan_id", "member_id", "display_name", "outbound_status", "return_status", "outbound_seats"],
  d1_migrations: ["name"],
});

export function snapshot(path) {
  const tables = userTables(path); const counts = {}; const records = {};
  for (const table of tables) counts[table] = query(path, `SELECT COUNT(*) AS n FROM "${table}"`)[0].n;
  for (const [table, wanted] of Object.entries(keyRecords)) {
    if (!tables.includes(table)) continue;
    const columns = new Set(query(path, `PRAGMA table_info("${table}")`).map((column) => column.name));
    const selected = wanted.filter((column) => columns.has(column));
    records[table] = { columns: selected, rows: query(path, `SELECT ${selected.map((column) => `"${column}"`).join(",")} FROM "${table}"`).map((row) => JSON.stringify(selected.map((column) => row[column]))).sort() };
  }
  return { tables, counts, records };
}

/** Rows present before the update that are missing or changed afterwards, and tables whose row count fell. */
export function compareSnapshots(before, after, { allowChanged = {} } = {}) {
  const problems = []; const notes = [];
  for (const table of before.tables) {
    if (!after.tables.includes(table)) { problems.push(`table ${table} no longer exists`); continue; }
    if (after.counts[table] < before.counts[table]) problems.push(`${table}: ${before.counts[table]} rows before, ${after.counts[table]} after`);
    else if (after.counts[table] > before.counts[table]) notes.push(`${table}: +${after.counts[table] - before.counts[table]} rows`);
  }
  for (const table of after.tables) if (!before.tables.includes(table)) notes.push(`new table ${table} (${after.counts[table]} rows)`);
  for (const [table, previous] of Object.entries(before.records)) {
    const current = after.records[table];
    if (!current) continue;
    const shared = previous.columns.filter((column) => current.columns.includes(column));
    const project = (record, columns) => record.rows.map((row) => { const values = JSON.parse(row); return JSON.stringify(shared.map((column) => values[columns.indexOf(column)])); });
    const remaining = new Set(project(current, current.columns));
    const missing = project(previous, previous.columns).filter((row) => !remaining.has(row));
    if (missing.length && !allowChanged[table]) problems.push(`${table}: ${missing.length} key record(s) missing or changed, first ${missing[0]}`);
    else if (missing.length) notes.push(`${table}: ${missing.length} record(s) changed as expected (${allowChanged[table]})`);
  }
  return { problems, notes };
}

// ---------------------------------------------------------------------------------------------------------------------
// Workers in Miniflare

/** Every outbound request a Worker makes is refused and recorded, so nothing leaves this computer. */
function refusingOutbound(record) {
  return async (request) => {
    record.push({ method: request.method, url: request.url });
    return new Response(JSON.stringify({ error: "Outbound requests are disabled during a local rehearsal" }), { status: 503, headers: { "content-type": "application/json" } });
  };
}

async function startApiWorker({ tree, bundle, stateDirectory, vars, outbound }) {
  const { Miniflare, convertV4MiniflareOptions } = createRequire(join(tree, "package.json"))("miniflare");
  // The bundle is one module; it is passed as source because scriptPath fails to load it on Windows.
  const options = { modules: true, script: await readFile(bundle, "utf8"), compatibilityDate: "2026-08-01", resourcePersistencePath: join(stateDirectory, "v3"),
    d1Databases: { DB: databaseId }, bindings: vars, outboundService: refusingOutbound(outbound) };
  return readyWorker(new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options));
}
async function readyWorker(worker) {
  try { await worker.ready; return worker; }
  catch (error) { await worker.dispose().catch(() => {}); throw error; }
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
/** The generated Pages _worker.js with an ASSETS binding over the built dashboard and its API origin routed to the local API. */
async function startPagesProxy({ tree, dist, api, upstreamOrigin, outbound }) {
  const { Miniflare, convertV4MiniflareOptions } = createRequire(join(tree, "package.json"))("miniflare");
  const assets = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = resolve(dist, `.${path}`);
    if (!file.startsWith(resolve(dist) + sep) || !existsSync(file) || (await lstat(file)).isDirectory() || file === resolve(dist, "_worker.js")) return new Response("Not found", { status: 404 });
    return new Response(await readFile(file), { headers: { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" } });
  };
  const forward = async (request) => {
    const url = new URL(request.url);
    if (url.origin !== upstreamOrigin) { outbound.push({ method: request.method, url: request.url }); return new Response("Outbound requests are disabled during a local rehearsal", { status: 503 }); }
    return api.dispatchFetch(request.url, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  };
  const options = { modules: true, script: await readFile(join(dist, "_worker.js"), "utf8"), compatibilityDate: "2026-08-01", serviceBindings: { ASSETS: assets }, outboundService: forward };
  return readyWorker(new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options));
}

/** A small API client over dispatchFetch that keeps the session cookie. */
export function apiClient(worker, origin = apiOrigin) {
  const client = {
    cookie: undefined,
    async call(method, path, body, { dashboard = true, headers = {}, cookie = client.cookie } = {}) {
      const init = { method, headers: { ...headers } };
      if (cookie) init.headers.cookie = cookie;
      if (dashboard) init.headers.origin = dashboardOrigin;
      if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
      const response = await worker.dispatchFetch(`${origin}${path}`, init);
      const text = await response.text();
      let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
      const setCookie = response.headers.get("set-cookie");
      const session = setCookie ? /lancerlogin_session=([^;]*)/.exec(setCookie)?.[1] : undefined;
      if (session !== undefined && cookie === client.cookie) client.cookie = session ? `lancerlogin_session=${session}` : undefined;
      return { status: response.status, body: json, text, headers: response.headers };
    },
    async ok(method, path, body, options) {
      const result = await client.call(method, path, body, options);
      if (result.status < 200 || result.status >= 300) fail(`${method} ${path} returned ${result.status}: ${result.text.slice(0, 500)}`);
      return result.body;
    },
  };
  return client;
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic installation

const syntheticMembers = [
  ["R-1001", "Avery", "Synthetic"], ["R-1002", "Blake", "Synthetic"], ["R-1003", "Casey", "Synthetic"], ["R-1004", "Devon", "Synthetic"],
  ["R-1005", "Emerson", "Synthetic"], ["R-1006", "Finley", "Synthetic"], ["R-1007", "Harper", "Synthetic"], ["R-1008", "Jordan", "Synthetic"],
].map(([memberId, firstName, lastName]) => ({ memberId, firstName, lastName, email: `${firstName.toLowerCase()}@example.invalid` }));

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** A meeting whose attendance window is open now and that stays within one UTC date. */
function currentMeetingWindow(now = Date.now()) {
  const midnight = Date.parse(`${isoDay(now)}T00:00:00.000Z`);
  return { startsAt: new Date(Math.max(now - 5 * 60_000, midnight)).toISOString(), endsAt: new Date(Math.min(now + 55 * 60_000, midnight + 86_400_000 - 1_000)).toISOString() };
}

async function completeSetupStep(api, moduleId, stepId) {
  const modules = await api.ok("GET", "/platform/modules");
  const generation = modules.modules.find((module) => module.id === moduleId)?.generation;
  return api.ok("PUT", `/admin/modules/${moduleId}/setup`, { generation, stepId, outcome: "completed" });
}

/** Seed through the FROM Worker's API, as an Administrator and a kiosk would. Returns what later checks look for. */
export async function seedInstallation(api, { setupCode, password, step }) {
  const seeded = { username: "rehearsal-admin" };
  await step("first Admin", () => api.ok("POST", "/setup/bootstrap", { setupCode, organizationName: "Rehearsal Robotics", timeZone, authMode: "local", localUsername: seeded.username, localPassword: password }));
  await step("sign in", async () => { await api.ok("POST", "/auth/local", { username: seeded.username, password }); seeded.cookie = api.cookie; });
  await step("enable modules", async () => {
    const modules = await api.ok("GET", "/platform/modules");
    const available = modules.modules.map((module) => module.id);
    seeded.enabledModules = ["attendance", "hour-tracking", "carpool"].filter((id) => available.includes(id));
    await api.ok("PUT", "/admin/modules", { enabled: seeded.enabledModules, revision: modules.revision });
  });
  await step("roster", async () => {
    await api.ok("POST", "/admin/members", { members: syntheticMembers });
    seeded.members = (await api.ok("GET", "/admin/members")).members;
  });
  const memberByExternal = (id) => seeded.members.find((member) => member.memberId === id);

  await step("Attendance setup", async () => {
    const rules = await api.ok("GET", "/module-setup/attendance/rules");
    await api.ok("PUT", "/module-setup/attendance/rules", { values: { ...rules.values, lateScanMinutes: 30 }, expected: rules.values });
    await completeSetupStep(api, "attendance", "rules");
    const window = currentMeetingWindow();
    seeded.currentMeeting = (await api.ok("POST", "/module-setup/attendance/meeting", { title: "Rehearsal build session", ...window, required: true })).id;
    await completeSetupStep(api, "attendance", "meeting");
    await api.ok("POST", "/module-setup/attendance/input", { action: "start", name: "Rehearsal simulator" });
    await api.ok("POST", "/module-setup/attendance/input", { action: "scan", memberId: "R-1001", meetingId: seeded.currentMeeting });
    await completeSetupStep(api, "attendance", "input");
  });
  await step("past meetings and attendance", async () => {
    // Since v2.1.0-beta.1 a member's attendance starts the day they join the roster, so the synthetic members start a
    // month back to take attendance at the past meetings. Releases without the setting answer 404 and need nothing.
    for (const member of seeded.members) {
      const set = await api.call("PATCH", `/admin/attendance/members/${encodeURIComponent(member.memberId)}`, { attendanceRequiredFrom: isoDay(Date.now() - 30 * 86_400_000), expected: null });
      if (set.status !== 200 && set.status !== 404) throw new Error(`PATCH attendance start returned ${set.status}: ${JSON.stringify(set.body)}`);
    }
    seeded.pastMeetings = [];
    for (const daysAgo of [14, 7]) {
      const start = Date.parse(`${isoDay(Date.now() - daysAgo * 86_400_000)}T17:00:00.000Z`);
      const created = await api.ok("POST", "/meetings", { title: `Rehearsal meeting ${daysAgo} days ago`, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 2 * 3_600_000).toISOString(), required: true, notes: "Synthetic" });
      const meetingId = created.meeting.id; seeded.pastMeetings.push(meetingId);
      for (const [index, member] of seeded.members.slice(0, 5).entries()) {
        await api.ok("POST", "/attendance", { eventId: `rehearsal-${meetingId}-${member.memberId}`, memberId: member.memberId, meetingId, occurredAt: new Date(start + (5 + index) * 60_000).toISOString(), desiredAction: "check_in" });
      }
    }
    const absent = memberByExternal("R-1008");
    await api.ok("POST", "/attendance/corrections", { memberId: absent.id, meetingId: seeded.pastMeetings[0], disposition: "excused", reason: "Synthetic excused absence" });
  });
  await step("paired synthetic kiosk", async () => {
    const pairing = await api.ok("POST", "/admin/pairing-codes", { kioskName: "Rehearsal kiosk", purpose: "hardware" });
    const kiosk = await api.ok("POST", "/kiosk/pair", { code: pairing.code, kioskName: "Rehearsal kiosk" }, { cookie: null, dashboard: false });
    seeded.kiosk = { id: kiosk.kioskId, token: kiosk.kioskToken, pairingId: kiosk.pairingId };
    const auth = { cookie: null, dashboard: false, headers: { authorization: `Bearer ${kiosk.kioskToken}` } };
    await api.ok("POST", "/kiosk/heartbeat", { readerOnline: false, releaseVersion: "rehearsal" }, auth);
    await api.ok("POST", "/kiosk/attendance", { eventId: `rehearsal-kiosk-${randomUUID()}`, memberId: "R-1002", meetingId: seeded.currentMeeting, occurredAt: new Date().toISOString(), pairingId: kiosk.pairingId }, auth);
    seeded.kioskRosterBefore = (await api.ok("GET", "/kiosk/roster", undefined, auth)).members.length;
  });
  if (seeded.enabledModules.includes("hour-tracking")) await step("Outreach setup, activities and entries", async () => {
    const rules = await api.ok("GET", "/module-setup/hour-tracking/rules");
    await api.ok("PUT", "/module-setup/hour-tracking/rules", { reportingDays: 30, reopenHours: 48, revision: rules.values.revision });
    await completeSetupStep(api, "hour-tracking", "rules");
    const team = await api.ok("POST", "/module-setup/hour-tracking/catalog", { name: "Rehearsal Rookies", number: "99999", program: "FTC" });
    await completeSetupStep(api, "hour-tracking", "catalog");
    const label = await api.ok("POST", "/admin/hours/labels", { name: "Community" });
    const yesterday = isoDay(Date.now() - 86_400_000);
    const task = await api.ok("POST", "/admin/hours/activities", { mode: "task", title: "Rehearsal library cleanup", serviceDate: yesterday, labelIds: [label.id] });
    const support = await api.ok("POST", "/admin/hours/activities", { mode: "team", teamId: team.id, title: "Rehearsal mentoring", serviceDate: yesterday, labelIds: [] });
    seeded.outreach = { teamId: team.id, labelId: label.id, activityIds: [task.id, support.id], entryIds: [] };
    for (const [index, member] of seeded.members.slice(0, 4).entries()) {
      const entry = await api.ok("POST", "/admin/hours/entries", { memberId: member.id, activityId: index % 2 ? support.id : task.id, serviceDate: yesterday, startLocal: "09:00", endLocal: `1${index}:30`, expectedTimeZone: timeZone, idempotencyKey: `rehearsal-entry-${member.memberId}-0001`, staffReason: "Synthetic staff entry", taskNotes: "Synthetic" });
      seeded.outreach.entryIds.push(entry.id ?? entry.entry?.id);
    }
  });
  if (seeded.enabledModules.includes("carpool")) await step("Carpool plan and participants", async () => {
    // The first plan is created through Carpool's setup route, which completes its only setup step.
    let plan = await api.ok("POST", "/module-setup/carpool/plan", { title: "Rehearsal regional event", destination: "Synthetic Arena, Example City" });
    const planId = plan.plan?.id ?? plan.id;
    await completeSetupStep(api, "carpool", "workspace");
    const people = [
      { member: "R-1003", displayName: "Casey Synthetic", outboundStatus: "offer", outboundSeats: 3, latitude: 40.0, longitude: -75.0 },
      { member: "R-1004", displayName: "Devon Synthetic", outboundStatus: "needs-ride", latitude: 40.01, longitude: -75.01 },
      { member: undefined, displayName: "Guest Synthetic", outboundStatus: "needs-ride", latitude: 40.02, longitude: -75.02 },
    ];
    for (const person of people) {
      const revision = plan.plan?.revision ?? plan.revision;
      plan = await api.ok("POST", `/admin/carpool/plans/${encodeURIComponent(planId)}/people`, {
        planRevision: revision, memberId: person.member ? memberByExternal(person.member).id : null, displayName: person.displayName, contact: "",
        outboundStatus: person.outboundStatus, outboundSeats: person.outboundSeats, outboundAddress: "Synthetic address", outboundLatitude: person.latitude, outboundLongitude: person.longitude,
        returnStatus: person.outboundStatus, returnSeats: person.outboundSeats, returnSameAsOutbound: true, notes: "",
      });
    }
    seeded.carpool = { planId, people: people.length };
  });
  return seeded;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rehearsal

function createReport(options) {
  const report = { startedAt: new Date().toISOString(), options, trees: {}, steps: [], checks: [], defects: [], notes: [], outbound: [] };
  report.check = (name, passed, detail = "") => { report.checks.push({ name, passed: Boolean(passed), detail: String(detail) }); console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); return passed; };
  report.step = async (name, action) => {
    const started = Date.now();
    try { const value = await action(); report.steps.push({ name, ok: true, seconds: Math.round((Date.now() - started) / 1000) }); console.log(`ok   ${name} (${Math.round((Date.now() - started) / 1000)}s)`); return value; }
    catch (error) { report.steps.push({ name, ok: false, seconds: Math.round((Date.now() - started) / 1000), error: error?.message ?? String(error) }); console.log(`FAIL ${name}: ${error?.message ?? error}`); throw error; }
  };
  return report;
}

export function renderReport(report) {
  const lines = [];
  const passed = report.checks.filter((check) => check.passed).length;
  lines.push(`# Local update rehearsal: ${report.trees.from?.label ?? report.options.from} to ${report.trees.to?.label ?? report.options.to}`, "");
  lines.push(`- Started: ${report.startedAt}`, `- Finished: ${report.finishedAt ?? "(stopped)"}`, `- Result: ${report.result ?? "incomplete"} (${passed} of ${report.checks.length} checks passed)`);
  for (const key of ["from", "to"]) if (report.trees[key]) lines.push(`- ${key.toUpperCase()}: ${report.trees[key].ref} = ${report.trees[key].sha} (${report.trees[key].repository} repository, package version ${report.trees[key].version})`);
  if (report.targetTag) lines.push(`- Target tag used for the migration policy and release version: ${report.targetTag}`);
  if (report.selection) lines.push(`- Plugin selection: ${report.selection}`);
  lines.push(`- Outbound requests attempted by the Workers (all refused): ${report.outbound.length ? report.outbound.map((entry) => `${entry.method} ${entry.url}`).join("; ") : "none"}`, "");
  lines.push("## Steps", "", "| Step | Result | Seconds |", "| --- | --- | --- |");
  for (const step of report.steps) lines.push(`| ${step.name} | ${step.ok ? "ok" : `failed: ${String(step.error).replaceAll("|", "/").replaceAll("\n", " ").slice(0, 300)}`} | ${step.seconds} |`);
  lines.push("", "## Checks", "", "| Check | Result | Detail |", "| --- | --- | --- |");
  for (const check of report.checks) lines.push(`| ${check.name} | ${check.passed ? "pass" : "FAIL"} | ${check.detail.replaceAll("|", "/").replaceAll("\n", " ").slice(0, 400)} |`);
  if (report.notes.length) lines.push("", "## Notes", "", ...report.notes.map((note) => `- ${note}`));
  lines.push("", "## Not covered", "", "- Real Cloudflare behavior: D1 time travel, Worker and Pages deployment propagation, secrets API, custom domains, rate limits.",
    "- The GitHub side of a web update: release discovery, dispatch, the private deployment repository, workflow permissions and credentials.",
    "- Maintenance-mode write suspension and the durable request row (prepare, claim and request states are local stand-ins).",
    "- Browser rendering of the dashboard (the built assets and Pages proxy are served, not exercised in a browser).",
    "- Physical kiosks, Raspberry Pi updates and fingerprint hardware.", "");
  return `${lines.join("\n")}\n`;
}

async function writeSecrets(path, secrets) { await writeFile(path, JSON.stringify(secrets, null, 2), { mode: 0o600 }); }

export async function rehearse(options) {
  const report = createReport({ ...options });
  const work = options.workDir ? resolve(options.workDir) : await mkdtemp(join(tmpdir(), "lancerlogin-rehearsal-"));
  if (options.workDir) { await mkdir(work, { recursive: true }); if ((await readdir(work)).length) fail(`--work-dir ${work} must be empty`); }
  const paths = { from: join(work, "from"), to: join(work, "to"), state: join(work, "d1"), checkpoint: join(work, "checkpoint"), controller: join(work, "deployment-control"), refusal: join(work, "refusal-control"), home: join(work, "wrangler-home"), logs: join(work, "logs") };
  for (const path of [paths.state, paths.checkpoint, paths.controller, paths.refusal, paths.home, paths.logs]) await mkdir(path, { recursive: true });
  const logFile = join(paths.logs, "commands.log");
  const log = async (text) => { await writeFile(logFile, `${text}\n`, { flag: "a" }); };
  const wranglerEnv = wranglerEnvironment(paths.home);
  const reportPath = resolve(options.report ?? join(work, "rehearsal-report.md"));
  let fromWorker; let toWorker; let pagesWorker;
  console.log(`Local update rehearsal in ${work}`);
  try {
    // Trees ---------------------------------------------------------------------------------------------------------
    for (const key of ["from", "to"]) {
      const resolved = await report.step(`resolve ${key.toUpperCase()} ${options[key]}`, () => resolveRef(options[key]));
      report.trees[key] = { ...resolved, label: options[key] };
    }
    if (report.trees.from.sha === report.trees.to.sha) fail("FROM and TO are the same commit");
    for (const key of ["from", "to"]) {
      await report.step(`export ${key.toUpperCase()} tree`, () => extractTree(report.trees[key].sha, paths[key], work));
      report.trees[key].version = JSON.parse(await readFile(join(paths[key], "package.json"), "utf8")).version;
    }
    for (const key of ["from", "to"]) await report.step(`npm ci ${key.toUpperCase()}`, () => mustRun(`npm ci in ${key}`, "npm", ["ci", "--no-audit", "--no-fund"], { cwd: paths[key], env: { ...childEnvironment(), npm_config_update_notifier: "false" }, log }));

    const fromVersion = report.trees.from.version; const toVersion = report.trees.to.version;
    const { compareReleaseVersions } = await importFrom(paths.to, "packages/shared/src/release-policy.mjs");
    const targetTag = options.targetTag ?? `v${toVersion}`;
    report.targetTag = targetTag;
    if (targetTag !== `v${toVersion}`) report.notes.push(`TO's package version is ${toVersion}; the rehearsal used ${targetTag} as the release tag (the real updater refuses a source whose version differs from the tag).`);
    if (compareReleaseVersions(targetTag, fromVersion) !== 1) report.notes.push(`${targetTag} does not move forward from ${fromVersion}; pass --target-tag for an unversioned candidate. The migration policy will refuse.`);
    const targetVersion = targetTag.slice(1);

    // Selections ----------------------------------------------------------------------------------------------------
    const selectionSource = resolve(options.selection ?? join(toolRoot, defaultSelection));
    const selectionText = await readFile(selectionSource, "utf8");
    const selectionPath = join(paths.controller, "lancerlogin.modules.json");
    await writeFile(selectionPath, selectionText);
    const selection = JSON.parse(selectionText);
    report.selection = selection.modules.map((module) => `${module.id}@${module.commit}`).join(", ") || "(empty)";
    const refusalSelection = { format: 1, modules: selection.modules.filter((module) => module.id !== "carpool") };
    const refusalPath = join(paths.refusal, "lancerlogin.modules.json");
    await writeFile(refusalPath, `${JSON.stringify(refusalSelection, null, 2)}\n`);
    const compositionEnv = { ...childEnvironment(), npm_config_update_notifier: "false" };

    // Shared secrets and configuration ------------------------------------------------------------------------------
    const setupCode = randomBytes(12).toString("base64url"); const password = `rehearsal ${randomBytes(9).toString("base64url")}`;
    const secrets = { SESSION_KEY: randomBytes(32).toString("base64url"), INTEGRATION_KEY: randomBytes(32).toString("base64url"), BOOTSTRAP_CODE_HASH: createHash("sha256").update(setupCode).digest("base64url") };
    const secretsPath = join(work, "secrets.json");
    await writeSecrets(secretsPath, secrets);
    const provision = async (tree, version, extraVars = {}) => {
      const { buildProvisionConfig } = await importFrom(tree, "scripts/prepare-cloudflare-provision.mjs");
      const { resolveDatabaseName } = await importFrom(tree, "scripts/database-identity.mjs");
      const databaseName = resolveDatabaseName(slug);
      const config = buildProvisionConfig(slug, [{ name: databaseName, uuid: databaseId }], version, databaseName).config;
      Object.assign(config.vars, { ALLOWED_ORIGIN: dashboardOrigin, UPDATE_REPOSITORY: "rehearsal/private-deployment", UPDATE_WORKFLOW_URL: "https://github.com/rehearsal/private-deployment/actions/workflows/upgrade-web.yml" }, extraVars);
      await mkdir(join(tree, ".provision"), { recursive: true });
      const configPath = join(tree, ".provision/wrangler.json");
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      return { config, configPath, databaseName };
    };
    const wrangler = (tree, label, args) => mustRun(label, process.execPath, [join(tree, "node_modules/wrangler/bin/wrangler.js"), ...args], { cwd: tree, env: wranglerEnv, log });
    const vaultIO = (tree, configPath) => ({
      listSecretNames: async () => Object.keys(JSON.parse(await readFile(secretsPath, "utf8"))),
      readVaultState: async () => query(await databaseFile(paths.state), "SELECT COALESCE((SELECT MAX(enabled) FROM kiosk_fingerprint_vault_settings),0) AS enabled, (SELECT COUNT(*) FROM kiosk_fingerprint_vault_templates) AS stored")[0],
      putSecret: async (name, value) => { const current = JSON.parse(await readFile(secretsPath, "utf8")); current[name] = value; await writeSecrets(secretsPath, current); },
    });
    const workerVars = async (config) => ({ ...config.vars, ...JSON.parse(await readFile(secretsPath, "utf8")) });

    // FROM: compose, build, migrate, run, seed ----------------------------------------------------------------------
    const fromProvision = await provision(paths.from, fromVersion);
    await report.step("compose FROM (official modules and selection)", () => mustRun("FROM composition", process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/compose-modules.mjs", "--selection", selectionPath, "--official-modules"], { cwd: paths.from, env: compositionEnv, log }));
    await report.step("build FROM Worker bundle (wrangler deploy --dry-run)", () => wrangler(paths.from, "FROM bundle", ["deploy", "--dry-run", "--outdir", join(paths.from, ".provision/api-build"), "--config", fromProvision.configPath]));
    await report.step("apply FROM migrations to the local D1", () => wrangler(paths.from, "FROM migrations", ["d1", "migrations", "apply", fromProvision.databaseName, "--local", "--persist-to", paths.state, "--config", fromProvision.configPath]));
    await report.step("FROM fingerprint storage key", async () => (await importFrom(paths.from, "scripts/ensure-fingerprint-vault-key.mjs")).ensureFingerprintVaultKey(vaultIO(paths.from)));
    const fromOutbound = [];
    fromWorker = await report.step("start FROM Worker in Miniflare", async () => startApiWorker({ tree: paths.from, bundle: join(paths.from, ".provision/api-build/index.js"), stateDirectory: paths.state, vars: await workerVars(fromProvision.config), outbound: fromOutbound }));
    const fromApi = apiClient(fromWorker);
    const fromHealth = await fromApi.ok("GET", "/health", undefined, { dashboard: false });
    report.check("FROM health", fromHealth.ok === true && fromHealth.releaseVersion === fromVersion, JSON.stringify(fromHealth));
    const seeded = await report.step("seed synthetic data through the FROM API", () => seedInstallation(fromApi, { setupCode, password, step: (name, action) => report.step(`seed: ${name}`, action) }));
    report.outbound.push(...fromOutbound);
    await fromWorker.dispose(); fromWorker = undefined;

    const databasePath = await databaseFile(paths.state);
    const before = snapshot(databasePath);
    await writeFile(join(paths.logs, "snapshot-before.json"), JSON.stringify(before, null, 2));
    report.notes.push(`Seeded rows before the update: ${["members", "meetings", "attendance_events", "attendance_corrections", "kiosks", "hours_activities", "hours_entries", "carpool_plans", "carpool_people"].map((table) => `${table} ${before.counts[table] ?? "n/a"}`).join(", ")}.`);
    const databaseDigest = async () => { const files = (await readdir(dirname(databasePath))).filter((name) => !name.endsWith("-shm")).sort(); return sha256(JSON.stringify(await Promise.all(files.map(async (name) => [name, sha256(await readFile(join(dirname(databasePath), name)))])))); };

    // TO: updater modules -------------------------------------------------------------------------------------------
    const updater = await importFrom(paths.to, "scripts/run-web-upgrade.mjs");
    const composer = await importFrom(paths.to, "scripts/compose-modules.mjs");
    const readQuery = async (sql, params = []) => query(databasePath, sql, params);
    const migrationFiles = async () => {
      const directory = join(paths.to, "apps/api/migrations");
      const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
      return Promise.all(names.map(async (name) => ({ name, content: await readFile(join(directory, name), "utf8") })));
    };
    const applied = () => query(databasePath, "SELECT name FROM d1_migrations ORDER BY id").map((row) => row.name);
    const policy = JSON.parse(await readFile(join(paths.to, "scripts/web-upgrade-policy.json"), "utf8"));

    // The composition build guard refuses a CI build before composition.
    const guardScript = join(paths.to, "scripts/check-module-composition.mjs");
    if (existsSync(guardScript)) {
      const refused = await run(process.execPath, [guardScript], { cwd: paths.to, env: { ...childEnvironment(), CI: "true" }, log });
      report.check("composition build guard refuses an uncomposed CI build", refused.status === 1 && /module composition did not run/.test(refused.output), refused.output.trim().split("\n")[0]);
    } else report.check("composition build guard present in TO", false, "scripts/check-module-composition.mjs is missing");

    // Refusal path: without Carpool in the selection, preflight must stop before any change.
    await report.step("refusal path: selection without Carpool", async () => {
      const digest = await databaseDigest(); const migrationsBefore = applied();
      const refusals = [];
      await updater.validateMigrationPolicy(policy, await migrationFiles(), migrationsBefore, fromVersion, targetTag);
      await updater.firstPartyModuleIds(paths.to);
      let error;
      try {
        await updater.preflightModules({ pinnedSelectionSha: updater.gitBlobSha(await readFile(refusalPath, "utf8")), selectionPath: refusalPath,
          compose: () => updater.composeUpdateModules({ selectionPath: refusalPath, environment: compositionEnv }), query: readQuery, refuse: async (code) => { refusals.push(code); } });
      } catch (caught) { error = caught; }
      report.check("refusal: preflight stops with module_migration_required", error?.message === "module_migration_required", error?.message ?? "no refusal");
      report.check("refusal: recorded code names Carpool", refusals.includes("module_migration_required:carpool"), refusals.join(", ") || "none");
      report.check("refusal: database unchanged", digest === await databaseDigest() && JSON.stringify(applied()) === JSON.stringify(migrationsBefore), `${migrationsBefore.length} migrations applied before and after`);
      await composer.restoreModuleDefaults({ outputRoot: paths.to });
    });

    // The update, through TO's own executeWebUpgrade with a local adapter.
    const toOutbound = []; const pagesOutbound = []; const stages = []; let claimed = false; let composedModules = []; let firstPartyModules = []; let checkpoint;
    const marker = randomUUID();
    const toProvision = await provision(paths.to, targetVersion, { DEPLOYMENT_MARKER: marker });
    const proxyApiOrigin = apiOrigin;
    const context = { runId: "1", requestId: randomUUID(), tag: targetTag, sha: report.trees.to.sha };
    const localIO = {
      async preflight() {
        await updater.validateMigrationPolicy(policy, await migrationFiles(), applied(), fromVersion, targetTag);
        report.check("migration policy accepts the path (validateMigrationPolicy)", true, `${applied().length} applied, ${(await migrationFiles()).length} in TO`);
        firstPartyModules = await updater.firstPartyModuleIds(paths.to);
        composedModules = await updater.preflightModules({ pinnedSelectionSha: updater.gitBlobSha(selectionText), selectionPath,
          compose: () => updater.composeUpdateModules({ selectionPath, environment: compositionEnv }), query: readQuery, refuse: async (code) => fail(`unexpected refusal ${code}`) });
        report.check("preflight composes the selection", composedModules.includes("carpool"), `first-party ${firstPartyModules.join(", ")}; composed ${composedModules.join(", ")}`);
      },
      async claim() { if (claimed) return false; claimed = true; return true; },
      async state(state, stage, maintenance, error) { stages.push(`${state}/${stage}/${maintenance}${error ? `/${error}` : ""}`); },
      async build() {
        const ci = { ...childEnvironment(), CI: "true" };
        await mustRun("API workspace build (CI)", "npm", ["--workspace", "@lancerlogin/api", "run", "build"], { cwd: paths.to, env: ci, log });
        await wrangler(paths.to, "TO bundle", ["deploy", "--dry-run", "--outdir", join(paths.to, ".provision/api-build"), "--config", toProvision.configPath]);
        await mustRun("dashboard build (CI)", "npm", ["--workspace", "@lancerlogin/dashboard", "run", "build"], { cwd: paths.to, env: { ...ci, VITE_API_BASE_URL: "/api" }, log });
        const { buildPagesProxy } = await importFrom(paths.to, "scripts/prepare-pages-proxy.mjs");
        await writeFile(join(paths.to, "apps/dashboard/dist/_worker.js"), buildPagesProxy(proxyApiOrigin, targetVersion), { mode: 0o600 });
        report.check("CI build passes the composition guard", true, "API and dashboard workspace builds ran with CI=true");
      },
      async drain() {},
      async checkpoint() {
        for (const name of await readdir(dirname(databasePath))) await copyFile(join(dirname(databasePath), name), join(paths.checkpoint, name));
        return { databaseBookmark: `local-copy:${paths.checkpoint}`, workerVersionIds: [`from-${report.trees.from.sha}`], pagesDeploymentId: `from-${report.trees.from.sha}`, automaticDatabaseRestore: false };
      },
      async saveRecovery(recovery) { checkpoint = recovery; },
      async migrate() {
        await wrangler(paths.to, "TO migrations", ["d1", "migrations", "apply", toProvision.databaseName, "--local", "--persist-to", paths.state, "--config", toProvision.configPath]);
        const vault = await (await importFrom(paths.to, "scripts/ensure-fingerprint-vault-key.mjs")).ensureFingerprintVaultKey(vaultIO(paths.to));
        report.notes.push(`Fingerprint storage key during the update: ${vault.status}.`);
      },
      async deployApi() {
        toWorker = await startApiWorker({ tree: paths.to, bundle: join(paths.to, ".provision/api-build/index.js"), stateDirectory: paths.state, vars: await workerVars(toProvision.config), outbound: toOutbound });
      },
      async deployPages() {
        pagesWorker = await startPagesProxy({ tree: paths.to, dist: join(paths.to, "apps/dashboard/dist"), api: toWorker, upstreamOrigin: proxyApiOrigin, outbound: pagesOutbound });
      },
      async health() {
        const get = async (worker, url) => { const response = await worker.dispatchFetch(url); return response.json(); };
        const api = await get(toWorker, `${apiOrigin}/health?update=${context.requestId}`);
        const pages = await get(pagesWorker, `${dashboardOrigin}/__lancerlogin-release?update=${context.requestId}`);
        const proxy = await get(pagesWorker, `${dashboardOrigin}/api/health?update=${context.requestId}`);
        const healthy = updater.deployedHealthMatches({ api, pages, proxy, version: targetVersion, expectedModules: [...firstPartyModules, ...composedModules], marker });
        report.check("post-deployment health (deployedHealthMatches)", healthy, JSON.stringify({ api, pages, proxy }));
        if (!healthy) fail("health_mismatch");
      },
    };

    // Snapshot right after migrations, before the new Worker serves anything.
    const migrate = localIO.migrate;
    let afterMigrations;
    localIO.migrate = async () => { await migrate(); afterMigrations = snapshot(databasePath); };
    const outcome = await report.step("TO updater sequence (executeWebUpgrade, local adapter)", () => updater.executeWebUpgrade(context, localIO, {}));
    report.check("update succeeded", outcome?.succeeded === true, `stages: ${stages.join(" > ")}`);
    report.check("checkpoint taken before migrations", Boolean(checkpoint?.databaseBookmark), checkpoint?.databaseBookmark ?? "");
    // A second run of the same request must stop at claim. Preflight is skipped: it would need a fresh checkout.
    const duplicate = await updater.executeWebUpgrade(context, { ...localIO, preflight: async () => {} }, {});
    report.check("same run again is a duplicate without mutation", duplicate?.duplicate === true, JSON.stringify(duplicate));

    // Data preserved by the migrations alone.
    const migrationDiff = compareSnapshots(before, afterMigrations);
    report.check("migrations preserve every table and key record", migrationDiff.problems.length === 0, migrationDiff.problems.join("; ") || migrationDiff.notes.join("; "));
    const newMigrations = afterMigrations.records.d1_migrations.rows.length - before.records.d1_migrations.rows.length;
    report.notes.push(`Core migrations applied by the update: ${newMigrations} (${afterMigrations.records.d1_migrations.rows.filter((row) => !before.records.d1_migrations.rows.includes(row)).map((row) => JSON.parse(row)[0]).join(", ") || "none"}).`);

    // TO verification -----------------------------------------------------------------------------------------------
    await report.step("verify the updated installation", async () => {
      const api = apiClient(toWorker);
      const health = await api.ok("GET", "/health", undefined, { dashboard: false });
      report.check("TO health and module list", health.ok === true && health.releaseVersion === targetVersion && ["attendance", "hour-tracking", "carpool"].every((id) => health.modules.includes(id)), `modules ${health.modules.join(", ")}`);
      const afterStart = snapshot(databasePath);
      const startDiff = compareSnapshots(before, afterStart);
      report.check("data preserved after the new Worker started", startDiff.problems.length === 0, startDiff.problems.join("; ") || startDiff.notes.join("; "));
      const catalog = query(databasePath, "SELECT module_id, origin, source_commit, installed FROM platform_module_catalog ORDER BY module_id");
      const carpoolPin = selection.modules.find((module) => module.id === "carpool")?.commit;
      report.check("plugin catalog records the composed plugins", catalog.some((row) => row.module_id === "carpool" && row.origin === "external" && row.source_commit === carpoolPin && row.installed === 1) && catalog.some((row) => row.module_id === "hour-tracking" && row.origin === "external" && row.installed === 1), JSON.stringify(catalog));
      const ledger = query(databasePath, "SELECT module_id, COUNT(*) AS migrations FROM platform_module_migrations GROUP BY module_id ORDER BY module_id");
      report.check("plugin migration ledger present", ledger.length > 0 || catalog.length > 0, JSON.stringify(ledger));

      // Sessions and sign-in.
      const carried = await api.call("GET", "/auth/session", undefined, { cookie: seeded.cookie, dashboard: false });
      report.check("session issued by FROM is still accepted", carried.status === 200 && carried.body?.authenticated === true, `status ${carried.status}`);
      const login = await api.call("POST", "/auth/local", { username: seeded.username, password });
      report.check("local sign-in works after the update", login.status === 200, `status ${login.status}`);
      const session = await api.call("GET", "/auth/session", undefined, { dashboard: false });
      report.check("new session is valid", session.status === 200 && session.body?.user?.role === "admin", `status ${session.status}`);

      // Seeded data through the API.
      const members = await api.ok("GET", "/admin/members");
      report.check("roster returned", members.members.length === seeded.members.length, `${members.members.length} members`);
      const meetings = await api.ok("GET", "/meetings");
      report.check("meetings returned", meetings.meetings.length >= 3, `${meetings.meetings.length} meetings`);
      const attendance = await api.ok("GET", `/attendance?meetingId=${encodeURIComponent(seeded.pastMeetings[0])}`);
      report.check("attendance returned for a past meeting", attendance.attendance.filter((row) => row.checkedInAt).length === 5 && attendance.attendance.some((row) => row.correction === "excused"), `${attendance.attendance.filter((row) => row.checkedInAt).length} checked in`);
      const modules = await api.ok("GET", "/platform/modules");
      const phases = Object.fromEntries(modules.modules.map((module) => [module.id, module.phase]));
      report.check("module enablement preserved", seeded.enabledModules.every((id) => phases[id] === "enabled" || phases[id] === "active"), JSON.stringify(phases));
      if (seeded.outreach) {
        const activities = await api.ok("GET", "/admin/hours/activities");
        report.check("Outreach activities returned", seeded.outreach.activityIds.every((id) => activities.items.some((item) => item.id === id)), `${activities.items.length} activities`);
        const entries = await api.ok("GET", "/admin/hours/entries");
        const listed = entries.items ?? entries.entries ?? [];
        report.check("Outreach entries returned", listed.length >= seeded.outreach.entryIds.length, `${listed.length} entries`);
      }
      if (seeded.carpool) {
        const carpool = await api.ok("GET", `/admin/carpool/context?planId=${encodeURIComponent(seeded.carpool.planId)}`);
        const people = carpool.detail?.people ?? carpool.detail?.participants ?? [];
        report.check("Carpool plan and participants returned", carpool.plans.some((plan) => plan.id === seeded.carpool.planId) && people.length === seeded.carpool.people, `${people.length} participants`);
      }

      // Kiosk.
      const kioskAuth = { cookie: null, dashboard: false, headers: { authorization: `Bearer ${seeded.kiosk.token}` } };
      const config = await api.call("GET", "/kiosk/config", undefined, kioskAuth);
      report.check("paired kiosk credential still valid", config.status === 200 && config.body?.kiosk?.id === seeded.kiosk.id, `status ${config.status}`);
      const roster = await api.call("GET", "/kiosk/roster", undefined, kioskAuth);
      const etag = roster.headers.get("etag");
      report.check("kiosk roster returned", roster.status === 200 && roster.body?.members?.length === seeded.kioskRosterBefore, `${roster.body?.members?.length} members, etag ${etag}`);
      report.check("kiosk roster carries a revision", Boolean(etag), etag ?? "no etag");
      if (etag) {
        const unchanged = await api.call("GET", "/kiosk/roster", undefined, { ...kioskAuth, headers: { ...kioskAuth.headers, "if-none-match": etag } });
        report.check("kiosk roster revision answers 304 when unchanged", unchanged.status === 304, `status ${unchanged.status}`);
        await api.ok("POST", "/admin/members", { members: [{ memberId: "R-1009", firstName: "Kendall", lastName: "Synthetic" }] });
        const changed = await api.call("GET", "/kiosk/roster", undefined, { ...kioskAuth, headers: { ...kioskAuth.headers, "if-none-match": etag } });
        report.check("kiosk roster revision changes with the roster", changed.status === 200 && changed.headers.get("etag") !== etag && changed.body?.members?.length === seeded.kioskRosterBefore + 1, `status ${changed.status}, etag ${changed.headers.get("etag")}`);
      }

      // Pages proxy.
      const page = async (path, init = {}) => pagesWorker.dispatchFetch(`${dashboardOrigin}${path}`, init);
      const release = await (await page("/__lancerlogin-release")).json();
      report.check("Pages release marker", release.releaseVersion === targetVersion, JSON.stringify(release));
      const proxied = await (await page("/api/health")).json();
      report.check("Pages proxy reaches the API", proxied.ok === true && proxied.releaseVersion === targetVersion, `releaseVersion ${proxied.releaseVersion}`);
      const shell = await page("/", { headers: { accept: "text/html" } });
      const shellText = await shell.text();
      report.check("dashboard shell served with framing denied", shell.status === 200 && /<div id="root"|<script/i.test(shellText) && shell.headers.get("x-frame-options") === "DENY", `status ${shell.status}`);
      const deep = await page("/settings/carpool", { headers: { accept: "text/html" } });
      report.check("client route falls back to the dashboard shell", deep.status === 200 && (await deep.text()) === shellText, `status ${deep.status}`);
      const outboundBefore = pagesOutbound.length;
      const escape = await page("/api//evil.example/steal");
      report.check("//host escape refused", escape.status === 400 && pagesOutbound.length === outboundBefore, `status ${escape.status}, outbound ${pagesOutbound.length - outboundBefore}`);
      const encoded = await page("/api/%2F%2Fevil.example/steal");
      report.check("encoded //host stays on the API origin", encoded.status !== 200 || pagesOutbound.length === outboundBefore, `status ${encoded.status}`);
      report.check("signed-in API call through the Pages proxy", (await page("/api/auth/session", { headers: { cookie: api.cookie } })).status === 200, "GET /api/auth/session");
    });
    report.outbound.push(...toOutbound, ...pagesOutbound);
    report.check("no Worker made an outbound request", report.outbound.length === 0, report.outbound.map((entry) => entry.url).join(", ") || "none");
    await pagesWorker.dispose(); pagesWorker = undefined; await toWorker.dispose(); toWorker = undefined;

    // TO's no-cloud updater tests, on the committed plugin-free defaults as CI runs them.
    await report.step("TO updater no-cloud tests", async () => {
      await composer.restoreModuleDefaults({ outputRoot: paths.to });
      const env = { ...childEnvironment() };
      const suites = [["tests/web-upgrade.test.mjs", ["--test", "tests/web-upgrade.test.mjs"]]];
      const tsTests = (await readdir(join(paths.to, "tests-ts"))).filter((name) => /^web-upgrade-.+\.test\.ts$/.test(name)).map((name) => `tests-ts/${name}`);
      if (tsTests.length) suites.push([tsTests.join(" "), ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", ...tsTests]]);
      suites.push(["scripts/rehearse-web-upgrade.mjs", ["scripts/rehearse-web-upgrade.mjs"]]);
      for (const [name, args] of suites) {
        const result = await run(process.execPath, args, { cwd: paths.to, env, log });
        const summary = /(?:#|ℹ) pass (\d+)[\s\S]*?(?:#|ℹ) fail (\d+)/.exec(result.output);
        report.check(`TO test ${name}`, result.status === 0, summary ? `${summary[1]} passed, ${summary[2]} failed` : result.status === 0 ? "passed" : result.output.trim().split("\n").slice(-5).join(" "));
      }
    });
  } catch (error) {
    report.error = error?.message ?? String(error);
    report.check("rehearsal completed", false, report.error);
  } finally {
    for (const worker of [pagesWorker, toWorker, fromWorker]) if (worker) await worker.dispose().catch(() => {});
    report.finishedAt = new Date().toISOString();
    report.result = report.checks.every((check) => check.passed) ? "passed" : "failed";
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, renderReport(report));
    const { check, step, ...data } = report;
    await writeFile(reportPath.replace(/\.md$/, "") + ".json", JSON.stringify(data, null, 2));
    console.log(`\nReport: ${reportPath}`);
    if (options.keep) console.log(`Kept the work folder: ${work}`);
    else { process.chdir(toolRoot); await removeTree(work).catch((error) => console.log(`Could not remove ${work}: ${error.message}`)); }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  rehearse(options).then((report) => { process.exitCode = report.result === "passed" ? 0 : 1; }, (error) => { console.error(`Local update rehearsal failed: ${error?.stack ?? error}`); process.exitCode = 1; });
}
