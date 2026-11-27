#!/usr/bin/env node
// Measures what the Attendance reports, leaderboard, roster rates and CSV export cost the Worker, per request, in local
// workerd with local D1. Synthetic data only; nothing leaves this machine.
//
//   node --experimental-strip-types scripts/measure-report-cpu.mjs [--members 60] [--meetings 60] [--rounds 3] [--only builder]
//
// The Worker is bundled as it is deployed and run behind a wrapper that times each request and its wait on D1. Local
// workerd's clock advances during JavaScript, so (request time - D1 wait) approximates the invocation's CPU. It is this
// machine's CPU, not Cloudflare's: on the limited test deployment the same requests took several times longer. Compare
// the numbers with each other. "first" is the first call in a new runtime; "again" is the next call with nothing written
// in between; "after a scan" is the next call after one attendance event was written.
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { applyMigration, coreMigrationNames } from "../tests/fixtures/miniflare-d1.mjs";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { referenceInstallationSql, referenceShape } from "../tests-ts/fixtures/reference-installation.ts";

const option = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : Number(process.argv[index + 1]); };
const members = option("members", 60), meetings = option("meetings", 60), rounds = option("rounds", 3);
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const root = fileURLToPath(new URL("../", import.meta.url));

const wrapper = `
import worker from "./apps/api/src/index.ts";
export default { async fetch(request, env, context) {
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const inner = new Request(request.url, { method: request.method, headers: request.headers, body });
  // One database object for the runtime's life, as on Cloudflare, so the Worker's caches see the same database each time.
  const counts = globalThis.measureCounts ??= { wait: 0, queries: 0 }; counts.wait = 0; counts.queries = 0;
  const source = env.DB; const originals = new WeakMap();
  const timed = (start) => { counts.queries += 1; const promise = start(); const from = performance.now(); return promise.finally(() => { counts.wait += performance.now() - from; }); };
  const wrap = (statement) => { const wrapped = { bind: (...values) => wrap(statement.bind(...values)), first: (...args) => timed(() => statement.first(...args)), all: () => timed(() => statement.all()), run: () => timed(() => statement.run()) }; originals.set(wrapped, statement); return wrapped; };
  const DB = globalThis.measuredDatabase ??= { prepare: (sql) => wrap(source.prepare(sql)), batch: (list) => timed(() => source.batch(list.map((statement) => originals.get(statement) ?? statement))) };
  globalThis.measureMarks = [];
  const started = performance.now();
  const response = await worker.fetch(inner, { ...env, DB }, context);
  const text = await response.text(); const total = performance.now() - started;
  const headers = new Headers(response.headers); headers.set("x-measure", JSON.stringify({ cpu: total - counts.wait, wait: counts.wait, queries: counts.queries, marks: globalThis.measureMarks }));
  return new Response(text, { status: response.status, headers });
} };`;
const bundle = (await build({ stdin: { contents: wrapper, resolveDir: root, loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false, logLevel: "error" })).outputFiles[0].text;

const requests = [
  ["report, every row", "/reports/attendance?roster=all"],
  ["Roster rates (summary)", "/reports/attendance?roster=all&useBaseline=true&detail=summary"],
  ["leaderboard, every row", "/reports/leaderboard?sort=regular-desc&page=1&pageSize=25"],
  ["Leaderboard page (summary)", "/reports/leaderboard?sort=regular-desc&detail=summary&page=1&pageSize=25"],
  ["attendance export", "/exports/attendance.csv"],
  ["report builder, 19 columns", "/reports/query", ({ label, from, to }) => ({ pageSize: "all", definition: { version: 2, dataset: "attendance.members", groupBy: ["core.member.identity"], period: { type: "fixed", from, to }, roster: "all", meetingType: "all", labelIds: [], labelMatch: "any", membership: "current", columns: [{ key: "core.member.name" }, { key: "core.member.id" }, { key: "core.member.labels" }, { key: "attendance.member.required-from" }, { key: "attendance.member.regular-rate" }, { key: "attendance.member.weighted-present" }, { key: "attendance.member.weighted-eligible" }, { key: "attendance.member.regular-period" }, { key: "attendance.member.assigned-policies" }, { key: "attendance.policy.official-result", labelId: label }, { key: "attendance.policy.official-status", labelId: label }, { key: "attendance.policy.report-result", labelId: label }, { key: "attendance.policy.report-status", labelId: label }, { key: "attendance.policy.report-summary" }, { key: "attendance.policy.history" }, { key: "attendance.detail.present-count" }, { key: "attendance.detail.present-dates" }, { key: "attendance.detail.absent-count" }, { key: "attendance.detail.excused-count" }], columnFilters: [], sort: { column: { key: "attendance.member.regular-rate" }, direction: "desc" } } })],
  ["policy preview, recent days", "/attendance/policy/preview", () => ({ recentDays: 45 })],
  ["meeting impact", ({ meeting }) => `/meetings/${meeting}/impact`, () => ({ required: false })],
];

async function start() {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle, compatibilityDate: "2026-08-01", d1Databases: ["DB"], bindings: { SESSION_KEY: secret, APP_MODE: "configured", ALLOWED_ORIGIN: "https://fixture.test" } }));
  const database = await runtime.getD1Database("DB");
  for (const name of coreMigrationNames()) await applyMigration(database, name);
  const shape = { ...referenceShape, members, labels: 4, kiosks: 1, meetingsPerSeason: meetings, seasons: 1, attendeesPerMeeting: Math.floor(members / 5), auditEntries: 10, deliveries: 10 };
  for (const sql of [
    "INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2024-08-01','local')",
    "INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2024-08-01')",
    "INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1)",
    "INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0)",
    "INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1)",
    "INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1)",
    "INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES ('primary','admin',0)",
    "INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES ('primary','admin',0)",
    "INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC')",
    ...referenceInstallationSql(shape),
    "INSERT INTO label_attendance_rules(id,installation_id,label_id,starts_on,ends_on,rule_type,threshold_percent,meetings_per_week,created_by,created_at,updated_at) SELECT 'test-rule-' || id,'primary',id,NULL,NULL,'weighted_percentage',75,NULL,'admin','2024-08-15','2024-08-15' FROM member_labels",
  ]) await database.exec(sql);
  const cookie = "lancerlogin_session=" + await createSessionCodec(secret).issue({ userId: "admin", role: "admin" });
  const context = { label: (await database.prepare("SELECT id FROM member_labels ORDER BY name LIMIT 1").first()).id, meeting: (await database.prepare("SELECT id FROM meetings ORDER BY starts_at LIMIT 1 OFFSET 3").first()).id, from: "2024-09-01", to: "2025-08-31" };
  const request = async (pathOf, bodyOf) => {
    const path = typeof pathOf === "function" ? pathOf(context) : pathOf; const body = bodyOf ? JSON.stringify(bodyOf(context)) : undefined;
    const result = await runtime.dispatchFetch("https://fixture.test" + path, { method: body ? "POST" : "GET", headers: { cookie, ...(body ? { "content-type": "application/json", origin: "https://fixture.test" } : {}) }, body });
    const text = await result.text();
    if (result.status !== 200) throw new Error(`${path}: ${result.status} ${text.slice(0, 200)}`);
    return { ...JSON.parse(result.headers.get("x-measure")), bytes: text.length };
  };
  let scans = 0;
  const scan = () => database.prepare("INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,created_by,action) SELECT 'test-measure-scan-' || ?,'primary',(SELECT id FROM members LIMIT 1),(SELECT id FROM meetings ORDER BY starts_at LIMIT 1 OFFSET ?),'manual','2024-09-01T18:05:00.000Z','admin','check_in'").bind(++scans, scans % meetings).run();
  await request("/health"); await request("/auth/session"); await request("/auth/session");
  return { runtime, request, scan };
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
const results = new Map();
for (const [name, path, body] of requests.filter(([name]) => name.includes(only))) for (let round = 0; round < rounds; round += 1) {
  // A new runtime for each request kind, so none is warmed by another.
  const { runtime, request, scan } = await start();
  try {
    const first = await request(path, body); const again = await request(path, body); await scan(); const after = await request(path, body);
    const list = results.get(name) ?? []; list.push({ first, again, after }); results.set(name, list);
  } finally { await runtime.dispose(); }
}
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const cell = (list, key) => `${median(list.map((item) => item[key].cpu)).toFixed(1)} ms`.padStart(12);
console.log(`${members} members, ${meetings} meetings, ${rounds} rounds; median CPU per request\n`);
console.log("request".padEnd(40), "first".padStart(12), "again".padStart(12), "after a scan".padStart(12), "queries".padStart(8), "bytes".padStart(10));
for (const [name, list] of results) {
  console.log(name.padEnd(40), cell(list, "first"), cell(list, "again"), cell(list, "after"), String(list[0].first.queries).padStart(8), String(list[0].first.bytes).padStart(10));
  const marks = list[0].first.marks; if (marks?.length) console.log("   first:", marks.map(([label, ms]) => `${label} ${ms.toFixed(1)}`).join(", "));
  const later = list[0].again.marks; if (later?.length) console.log("   again:", later.map(([label, ms]) => `${label} ${ms.toFixed(1)}`).join(", "));
}
