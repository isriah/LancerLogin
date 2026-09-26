import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { ReportDataCache } from "../apps/api/src/report-data-cache.ts";
import { databaseIdentity, measureD1, usageCategory, type D1Statement } from "../apps/api/src/d1-usage.ts";

class Database {
  sqlite = new DatabaseSync(":memory:");
  calls: { sql: string; values: unknown[] }[] = [];
  constructor() {
    for (const file of readdirSync("apps/api/migrations").filter((name) => name.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(`apps/api/migrations/${file}`, "utf8"));
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone,attendance_reporting_starts_on) VALUES ('primary','UTC','2026-02-01');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES ('m1','primary','one','First','Member','2026-01-01'),('m2','primary','two','Second','Member','2026-01-01');
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('meeting','primary','Meeting','2026-02-02T12:00:00Z','2026-02-02T13:00:00Z','admin','2026-01-01');
      INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) VALUES ('in','primary','m1','meeting','manual','2026-02-02T12:00:00Z','check_in'),('out','primary','m1','meeting','manual','2026-02-02T13:00:00Z','check_out');`);
  }
  prepare(sql: string): D1Statement {
    const database = this; let values: unknown[] = [];
    const execute = () => { database.calls.push({ sql, values }); return database.sqlite.prepare(sql); };
    return {
      bind(...args) { values = args; return this; },
      async first<T>() { return (execute().get(...values as []) ?? null) as T | null; },
      async all<T>() { return { results: execute().all(...values as []) as T[] }; },
      async run() {
        const before = Number(database.sqlite.prepare("SELECT total_changes() AS n").get()!.n);
        const statement = execute();
        const results = /RETURNING/i.test(sql) ? statement.all(...values as []) : (statement.run(...values as []), undefined);
        return { results, success: true, meta: { changes: Number(database.sqlite.prepare("SELECT total_changes() AS n").get()!.n) - before } };
      },
    };
  }
  async batch(statements: D1Statement[]) {
    this.sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
const secret = "A".repeat(43);
async function client(database: Database) {
  const env: Env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database };
  const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId: "admin", role: "admin" })}`;
  return (path: string, body?: object) => worker.fetch(new Request(`https://example.test${path}`, { method: body ? "POST" : "GET", headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
}

test("scoped member reports equal the full report and reuse data until a database write", async () => {
  const database = new Database();
  try {
    const fetch = await client(database);
    const full = await (await fetch("/reports/attendance?roster=all")).json() as { members: { member: { id: string } }[] };
    const scoped = await (await fetch("/reports/attendance?roster=all&memberId=m1")).json() as typeof full;
    assert.deepEqual(scoped.members, full.members.filter((item) => item.member.id === "m1"));
    const scopedReads = database.calls.filter((call) => call.sql.includes("FROM attendance_events e JOIN") && call.values.includes("m1"));
    assert.equal(scopedReads.length, 1); assert.match(scopedReads[0].sql, /e\.member_id = \?/);
    const before = database.calls.length;
    assert.deepEqual(await (await fetch("/reports/attendance?roster=all&memberId=m1")).json(), scoped);
    assert.equal(database.calls.slice(before).some((call) => call.sql.includes("FROM attendance_events e JOIN")), false);
    database.sqlite.exec("INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) VALUES ('c','primary','m1','meeting','excused','Synthetic reason','admin','2026-02-03');");
    const revised = await (await fetch("/reports/attendance?roster=all&memberId=m1")).json();
    assert.notDeepEqual(revised, scoped);
    assert.equal(database.calls.filter((call) => call.sql.includes("FROM attendance_events e JOIN") && call.values.includes("m1")).length, 2);
    database.sqlite.exec("UPDATE users SET active=0 WHERE id='admin'");
    assert.equal((await fetch("/reports/attendance?roster=all&memberId=m1")).status, 401);
  } finally { database.sqlite.close(); }
});

test("cache generations cover report inputs but ignore kiosk heartbeat writes", () => {
  const database = new Database();
  try {
    const revision = () => database.sqlite.prepare("SELECT revision FROM report_data_revision").get()!.revision;
    for (const statement of ["UPDATE members SET active=0 WHERE id='m2'", "UPDATE meetings SET required=0 WHERE id='meeting'", "UPDATE organization_settings SET late_scan_minutes=45", "DELETE FROM attendance_events WHERE id='in'"]) {
      const before = revision(); database.sqlite.exec(statement); assert.notEqual(revision(), before);
    }
    const before = revision(); database.sqlite.exec("UPDATE kiosks SET last_seen_at='2026-02-02'"); assert.equal(revision(), before);
    const triggers = database.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'report_revision_%'").get()!.n;
    assert.equal(triggers, 27);
  } finally { database.sqlite.close(); }
});

test("member and date filters retain label assignments preceding the reporting period", async () => {
  const database = new Database();
  try {
    database.sqlite.exec(`INSERT INTO member_labels(id,installation_id,name,created_at) VALUES ('group','primary','Synthetic group','2026-01-01');
      INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_at) VALUES ('join','primary','m1','group','add','2026-01-01','2026-01-01');
      INSERT INTO meeting_audience_labels(installation_id,meeting_id,label_id) VALUES ('primary','meeting','group');
      UPDATE meetings SET audience_mode='labels' WHERE id='meeting';`);
    const fetch = await client(database);
    const full = await (await fetch("/reports/attendance?roster=all&from=2026-02-01&to=2026-02-28")).json() as { members: { member: { id: string }; rows: { eligibility: string }[] }[] };
    const member = await (await fetch("/reports/attendance?roster=all&from=2026-02-01&to=2026-02-28&memberId=m1")).json() as typeof full;
    assert.deepEqual(member.members, full.members.filter((item) => item.member.id === "m1"));
    assert.equal(member.members[0].rows[0].eligibility, "required");
  } finally { database.sqlite.close(); }
});

test("a cached source still recomputes a meeting crossing its late-scan cutoff", async (context) => {
  const now = Date.parse("2026-02-02T13:00:30Z");
  context.mock.timers.enable({ apis: ["Date"], now });
  const database = new Database();
  try {
    database.sqlite.exec("UPDATE organization_settings SET late_scan_minutes=1");
    const fetch = await client(database);
    const before = await (await fetch("/reports/attendance?roster=all")).json() as { meetings: unknown[] };
    assert.equal(before.meetings.length, 0);
    const queries = database.calls.filter((call) => call.sql.includes("FROM attendance_events e JOIN")).length;
    context.mock.timers.setTime(now + 60_000);
    const after = await (await fetch("/reports/attendance?roster=all")).json() as { meetings: unknown[] };
    assert.equal(after.meetings.length, 1);
    assert.equal(database.calls.filter((call) => call.sql.includes("FROM attendance_events e JOIN")).length, queries);
  } finally { database.sqlite.close(); context.mock.timers.reset(); }
});

test("cleanup counts domain rows rather than revision trigger writes", async () => {
  const database = new Database();
  try {
    const fetch = await client(database);
    const result = await fetch("/attendance/cleanup", { memberId: "m1", meetingId: "meeting", confirmation: "CLEAR ATTENDANCE" });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { cleared: 2 });
  } finally { database.sqlite.close(); }
});

test("correction and contest lookup plans use bounded indexes", () => {
  const database = new Database();
  try {
    for (const [sql, expected] of [
      ["SELECT disposition FROM attendance_corrections WHERE member_id='m1' AND meeting_id='meeting' ORDER BY created_at DESC,id DESC LIMIT 1", "idx_corrections_member_meeting_latest"],
      ["SELECT COUNT(*) FROM discord_attendance_contests WHERE installation_id='primary' AND member_id='m1'", "idx_contests_member_history"],
      ["SELECT MIN(occurred_at) FROM attendance_events WHERE member_id='m1' AND meeting_id='meeting' AND action='check_in'", "idx_events_member_meeting_action_time"],
    ]) assert.match(JSON.stringify(database.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()), new RegExp(expected));
  } finally { database.sqlite.close(); }
});

test("cache is bounded, coalesces loads, expires, and does not retain failures or changed generations", async () => {
  let now = 0, generation = 1, loads = 0;
  const database = {}, other = {}, cache = new ReportDataCache<number>(100, 2, () => now);
  const revision = async () => generation, load = async () => ++loads;
  assert.deepEqual(await Promise.all([cache.read(database, "all", revision, load), cache.read(database, "all", revision, load)]), [1, 1]);
  assert.equal(await cache.read(other, "all", revision, load), 2);
  now = 101; assert.equal(await cache.read(database, "all", revision, load), 3);
  generation++; assert.equal(await cache.read(database, "all", revision, load), 4);
  await cache.read(database, "member1", revision, load); await cache.read(database, "member2", revision, load);
  assert.equal(await cache.read(database, "all", revision, load), 7);
  await assert.rejects(cache.read(database, "failed", revision, async () => { throw new Error("failure"); }));
  assert.equal(await cache.read(database, "failed", revision, load), 8);
  await cache.read(database, "changed", revision, async () => { generation++; return ++loads; });
  assert.equal(await cache.read(database, "changed", revision, load), 10);
});

test("D1 usage wrappers preserve database identity and batch RETURNING semantics", async () => {
  const database = new Database();
  try {
    const usage = measureD1(database);
    assert.equal(databaseIdentity(usage.database), database);
    const results = await usage.database.batch([usage.database.prepare("DELETE FROM attendance_events WHERE id=? RETURNING id").bind("in")]);
    assert.equal(results[0].results?.length, 1); assert.equal(results[0].meta?.changes, 2);
    assert.equal(usage.snapshot().measuredQueries, 1);
    assert.equal(usageCategory("/admin/members/private-person"), "/admin/members");
    assert.equal(usageCategory("/unknown/private-person"), "other");
  } finally { database.sqlite.close(); }
});
