#!/usr/bin/env node
// Measures what a dashboard backup and restore cost the Worker, per request, for the reference installation
// (tests-ts/fixtures/reference-installation.ts), in local workerd with local D1. Synthetic data only; nothing leaves
// this machine.
//
//   node --experimental-strip-types scripts/measure-backup-cpu.mjs [--seasons 3] [--rounds 3]
//
// The Worker is bundled as it is deployed and run inside workerd behind a wrapper that times each request and the time
// it spends waiting on D1. Local workerd's clock advances during JavaScript, so (request time - D1 wait) approximates the
// invocation's CPU: reading the request, JSON, checks, building statements and the answer. Two caveats:
// - The clock has 1 ms resolution, so short requests are reported as means over many requests.
// - It is this machine's CPU, not Cloudflare's, and it leaves out what the D1 binding costs on Cloudflare (about 0.45 ms
//   a query on the dev installation; tests-ts/scheduler-slice-cpu.test.ts). Compare the numbers with each other, and
//   with the 10 ms Workers Free allowance only as an order of magnitude.
// Each round starts a fresh runtime, so the first request of each kind runs cold, as a restore does in production.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { applyMigration, coreMigrationNames } from "../tests/fixtures/miniflare-d1.mjs";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { referenceInstallationSql, referenceShape } from "../tests-ts/fixtures/reference-installation.ts";
import { downloadBackup, restoreInParts } from "../apps/dashboard/src/backup-transfer.ts";

const option = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : Number(process.argv[index + 1]); };
const seasons = option("seasons", referenceShape.seasons); const rounds = option("rounds", 3);
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const root = fileURLToPath(new URL("../", import.meta.url));

// The wrapper: the Worker's own fetch, with every D1 call timed and the rows D1 reports written added up.
const wrapper = `
import worker from "./apps/api/src/index.ts";
export default { async fetch(request, env, context) {
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const inner = new Request(request.url, { method: request.method, headers: request.headers, body });
  let wait = 0, queries = 0, written = 0; const source = env.DB; const originals = new WeakMap();
  const count = (result) => { for (const item of Array.isArray(result) ? result : [result]) written += item?.meta?.rows_written ?? 0; return result; };
  const timed = (start) => { queries += 1; const promise = start(); const from = performance.now(); return promise.then(count).finally(() => { wait += performance.now() - from; }); };
  const wrap = (statement) => { const wrapped = { bind: (...values) => wrap(statement.bind(...values)), first: (...args) => timed(() => statement.first(...args)), all: () => timed(() => statement.all()), run: () => timed(() => statement.run()) }; originals.set(wrapped, statement); return wrapped; };
  const DB = { prepare: (sql) => wrap(source.prepare(sql)), batch: (list) => timed(() => source.batch(list.map((statement) => originals.get(statement) ?? statement))) };
  const started = performance.now();
  const response = await worker.fetch(inner, { ...env, DB }, context);
  const text = await response.text(); const total = performance.now() - started;
  const headers = new Headers(response.headers); headers.set("x-measure", JSON.stringify({ cpu: total - wait, wait, queries, written }));
  return new Response(text, { status: response.status, headers });
} };`;

const bundle = (await build({ stdin: { contents: wrapper, resolveDir: root, loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false, logLevel: "error" })).outputFiles[0].text;

async function start(seasonCount) {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: "2026-08-01", d1Databases: ["DB"], bindings: { SESSION_KEY: secret, APP_MODE: "configured" } }));
  const database = await runtime.getD1Database("DB");
  for (const name of coreMigrationNames()) await applyMigration(database, name);
  for (const sql of [
    "INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2024-08-01','local')",
    "INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2024-08-01')",
    "INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1)",
    "INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0)",
    "INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1)",
    "INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,0)",
    "INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES ('primary','admin',0)",
    "INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES ('primary','admin',0)",
    "INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC')",
    ...referenceInstallationSql({ ...referenceShape, seasons: seasonCount }),
  ]) await database.exec(sql);
  let cookie = "lancerlogin_session=" + await createSessionCodec(secret).issue({ userId: "admin", role: "admin" });
  const measures = new Map(); let phase = "";
  const request = async (path, init) => {
    const method = init?.method ?? "GET";
    const result = await runtime.dispatchFetch("https://fixture.test" + path, { method, headers: { cookie, ...(init?.body === undefined ? {} : { "content-type": "application/json" }) }, body: init?.body });
    const text = await result.text(); const set = result.headers.get("set-cookie"); if (set?.startsWith("lancerlogin_session=") && result.ok) cookie = set.split(";")[0];
    const kind = `${phase}: ${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "<id>").replace(/parts\/\d+/, "parts/<seq>").replace(/\?.*/, "")}`;
    const list = measures.get(kind) ?? []; list.push({ ...JSON.parse(result.headers.get("x-measure") ?? "{}"), bytes: Math.max(init?.body?.length ?? 0, text.length), status: result.status }); measures.set(kind, list);
    return new Response(text, { status: result.status, headers: result.headers });
  };
  // Warm the session check, as any signed-in dashboard has, so it is not counted against the first backup request.
  await request("/health"); await request("/auth/session"); await request("/auth/session"); measures.clear();
  return { runtime, request, measures, phase: (name) => { phase = name; } };
}

const all = new Map();
const keep = (measures) => { for (const [kind, list] of measures) all.set(kind, [...(all.get(kind) ?? []), ...list]); };
const records = (backup) => Object.values(backup.tables).reduce((total, rows) => total + rows.length, 0);
let size = "";

{
  // Before: the single requests. A restore body is limited to 10 MiB, which the reference installation's backup passes
  // within its second season, so the single-request restore is measured on one season.
  for (let round = 0; round < rounds; round += 1) {
    const one = await start(1); one.phase("one request, 1 season");
    const exported = await one.request("/admin/data/backup?scope=installation"); const text = await exported.text(); const backup = JSON.parse(text);
    const body = (confirmation, document = backup) => JSON.stringify({ scope: "installation", confirmation, backup: document });
    // Refused after reading the body (the confirmation is checked next), then after every check (a plugin section this
    // build cannot restore is refused last), then restored.
    one.phase("one request, 1 season, read only"); await one.request("/admin/data/restore", { method: "POST", body: body("no") });
    one.phase("one request, 1 season, read and check"); await one.request("/admin/data/restore", { method: "POST", body: body("RESTORE INSTALLATION", { ...backup, externalModules: [{ id: "synthetic-missing", label: "Synthetic", contractVersion: 1, backupVersion: 1, source: null, commit: null, tables: {} }] }) });
    one.phase("one request, 1 season"); const restored = await one.request("/admin/data/restore", { method: "POST", body: body("RESTORE INSTALLATION") });
    if (restored.status !== 200) throw new Error(`Single-request restore failed: ${restored.status}`);
    if (round === 0) console.log(`One season: ${records(backup)} records, ${text.length} bytes.`);
    keep(one.measures); await one.runtime.dispose();
  }
  // After: in parts, at the requested size.
  for (let round = 0; round < rounds; round += 1) {
    const reference = await start(seasons); reference.phase(`in parts, ${seasons} seasons`);
    const downloaded = await downloadBackup(reference.request, { scope: "installation" }); const backup = JSON.parse(downloaded.text);
    size = `${seasons} season${seasons === 1 ? "" : "s"}: ${records(backup)} records, ${downloaded.text.length} bytes.`;
    const restored = await restoreInParts(reference.request, { scope: "installation", confirmation: "RESTORE INSTALLATION", backup });
    if (restored?.status !== 200) throw new Error(`Restore in parts failed: ${restored?.status} ${await restored?.text()}`);
    keep(reference.measures);
    // What the single requests make of the same installation, after the measured requests so their garbage is not counted.
    if (round === 0) { const single = await reference.request("/admin/data/restore", { method: "POST", body: JSON.stringify({ scope: "installation", confirmation: "RESTORE INSTALLATION", backup }) }).catch(() => undefined); console.log(`${size} The single-request restore ${single ? `answered ${single.status}` : "was refused while its body was still being sent (over 10 MiB)"}.`); }
    await reference.runtime.dispose();
  }
  const rounded = (value) => Math.round(value * 100) / 100;
  console.log("\nrequest".padEnd(84), "count".padStart(6), "cpu mean".padStart(9), "cpu max".padStart(8), "D1 wait max".padStart(12), "queries".padStart(8), "bytes max".padStart(10), "rows written".padStart(13));
  for (const [kind, list] of all) {
    const cpu = list.map((item) => item.cpu);
    console.log(kind.padEnd(83), String(list.length).padStart(6), String(rounded(cpu.reduce((total, value) => total + value, 0) / cpu.length)).padStart(9), String(Math.max(...cpu)).padStart(8), String(Math.max(...list.map((item) => item.wait))).padStart(12), String(Math.max(...list.map((item) => item.queries))).padStart(8), String(Math.max(...list.map((item) => item.bytes))).padStart(10), String(Math.max(...list.map((item) => item.written))).padStart(13));
  }
  console.log("\ncpu and D1 wait are milliseconds per request; count is over all rounds. See the caveats at the top of this script.");
}
