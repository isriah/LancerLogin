// quick-check: covers apps/api/migrations/**
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { type Env } from "../apps/api/src/index.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { ReportDataCache } from "../apps/api/src/report-data-cache.ts";
import { databaseIdentity, measureD1, usageCategory, type D1Statement } from "../apps/api/src/d1-usage.ts";
import { applyCoreMigrations } from "./fixtures/d1-database.ts";
import { referenceInstallationSql, referenceShape } from "./fixtures/reference-installation.ts";

class Database {
  sqlite = new DatabaseSync(":memory:");
  calls: { sql: string; values: unknown[] }[] = [];
  batchQueue: Promise<void> = Promise.resolve();
  constructor() {
    applyCoreMigrations(this.sqlite);
    this.sqlite.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1);
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
        const results = /^\s*SELECT\b/i.test(sql) || /RETURNING/i.test(sql) ? statement.all(...values as []) : (statement.run(...values as []), undefined);
        return { results, success: true, meta: { changes: Number(database.sqlite.prepare("SELECT total_changes() AS n").get()!.n) - before } };
      },
    };
  }
  async batch(statements: D1Statement[]) {
    const execute = async () => {
      this.sqlite.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; }
      catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    };
    const pending = this.batchQueue.then(execute, execute);
    this.batchQueue = pending.then(() => undefined, () => undefined);
    return pending;
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

test("reports apply the current configured baseline in one request while explicit dates take precedence", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('older','primary','Older meeting','2026-01-02T12:00:00Z','2026-01-02T13:00:00Z','admin','2026-01-01')");
    const fetch = await client(database);
    const read = async (filter: string) => {
      const result = await fetch(`/reports/attendance?roster=all${filter}`); assert.equal(result.status, 200);
      return result.json() as Promise<{ meetings: { id: string }[]; baseline: string | null }>;
    };
    const baseline = await read("&useBaseline=true");
    assert.deepEqual(baseline, await read("&from=2026-02-01"));
    assert.deepEqual(baseline.meetings.map(meeting => meeting.id), ["meeting"]);
    const full = await read("");
    assert.equal(full.meetings.length, 2);
    assert.deepEqual(await read("&useBaseline=true&from=2026-01-01"), await read("&from=2026-01-01"));
    assert.deepEqual(await read("&useBaseline=false"), full);
    database.sqlite.exec("UPDATE organization_settings SET attendance_reporting_starts_on='2026-03-01'");
    assert.deepEqual((await read("&useBaseline=true")).meetings, []);
    database.sqlite.exec("UPDATE organization_settings SET attendance_reporting_starts_on=NULL");
    assert.equal((await read("&useBaseline=true")).meetings.length, 2);
    assert.equal((await fetch("/reports/attendance?useBaseline=invalid")).status, 400);
    database.sqlite.exec("UPDATE users SET active=0 WHERE id='admin'");
    assert.equal((await fetch("/reports/attendance?useBaseline=true")).status, 401);
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

test("a request reads its session user once, and reads started beside it keep the 401 and 403 precedence", async () => {
  const database = new Database();
  try {
    database.sqlite.exec("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('operator','primary','operator','operator','2026-01-01')");
    const env: Env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: secret, DB: database };
    const signedIn = async (userId: string, role: "admin" | "operator") => {
      const cookie = `lancerlogin_session=${await createSessionCodec(secret).issue({ userId, role })}`;
      return (path: string) => worker.fetch(new Request(`https://example.test${path}`, { headers: { cookie } }), env);
    };
    const admin = await signedIn("admin", "admin"); const operator = await signedIn("operator", "operator");
    const sessionReads = () => database.calls.filter((call) => call.sql.includes("FROM users WHERE installation_id = 'primary' AND id = ? AND active = 1 AND session_epoch = ?")).length;
    // Module routes check the session in the pre-check and again in the handler; an internal call reuses it too.
    const paths = ["/meetings", "/admin/members/one/history", "/auth/session", "/integrations/capabilities", "/admin/members", "/labels", "/platform/modules"];
    for (const path of paths) {
      const before = sessionReads();
      assert.equal((await admin(path)).status, 200, path);
      assert.equal(sessionReads() - before, 1, `${path} reads the session user once`);
    }
    // The role check decides before a read that would fail on its own (no update channel row exists here).
    for (const path of ["/admin/users", "/admin/update-channel"]) assert.equal((await operator(path)).status, 403, path);
    assert.equal((await operator("/meetings")).status, 403, "an operator without the module assignment");
    database.sqlite.exec("UPDATE users SET active=0 WHERE id='admin'");
    for (const path of [...paths, "/admin/update-channel", "/discord/contests"]) {
      const result = await admin(path);
      assert.equal(result.status, 401, path); assert.deepEqual(await result.json(), { error: "Session user is unavailable" }, path);
    }
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

test("cache is bounded, keeps finished loads only, expires, and does not retain failures or changed generations", async () => {
  let now = 0, generation = 1, loads = 0;
  const database = {}, other = {}, cache = new ReportDataCache<number>(100, 2, () => now);
  const revision = async () => generation, load = async () => ++loads;
  // Two reads that miss together each load: a load in progress is never shared between callers.
  assert.deepEqual(await Promise.all([cache.read(database, "all", revision, load), cache.read(database, "all", revision, load)]), [1, 2]);
  assert.equal(await cache.read(database, "all", revision, load), 2);
  assert.equal(await cache.read(other, "all", revision, load), 3);
  now = 101; assert.equal(await cache.read(database, "all", revision, load), 4);
  generation++; assert.equal(await cache.read(database, "all", revision, load), 5);
  await cache.read(database, "member1", revision, load); await cache.read(database, "member2", revision, load);
  assert.equal(await cache.read(database, "all", revision, load), 8);
  await assert.rejects(cache.read(database, "failed", revision, async () => { throw new Error("failure"); }));
  assert.equal(await cache.read(database, "failed", revision, load), 9);
  await cache.read(database, "changed", revision, async () => { generation++; return ++loads; });
  assert.equal(await cache.read(database, "changed", revision, load), 11);
  // A load that never finishes leaves nothing behind for the next caller to wait on.
  void cache.read(database, "stuck", revision, () => new Promise<number>(() => undefined));
  await new Promise((done) => setImmediate(done));
  assert.equal(await cache.read(database, "stuck", revision, load), 12);
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

// What the attendance export and the leaderboard trend were before they were rewritten to use less CPU, computed from
// the full report. The rewritten routes must answer exactly this.
type FullReport = { meetings: { id: string; title: string; startsAt: string; endsAt: string; required: number; attendanceWeight: number }[]; labels: { id: string; name: string }[]; timeZone: string; members: any[] };
const exportHeaders = ["meeting", "meetingStart", "meetingEnd", "audience", "required", "attendanceWeight", "memberId", "firstName", "lastName", "memberLabels", "disposition", "eligibility", "regularEligible", "regularWeight", "regularWeightedPresent", "regularRate", "regularAttended", "regularRequired", "regularFrom", "regularTo", "policyEligible", "policyWeight", "policyWeightedPresent", "policyLabel", "policyRuleType", "policyExcusedHandling", "policyStatus", "policyTarget", "policyAttended", "policyRequired", "policyRate", "policyFrom", "policyTo", "policyResults", "policyHistory", "weeklyTarget", "weekStartsOn", "weekSegmentStartsOn", "weekSegmentEndsOn", "checkedInAt", "checkedOutAt", "reason"];
function exportAsBefore(report: FullReport): string {
  const cell = (value: unknown) => { const text = value == null ? "" : String(value); const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; };
  const meetings = new Map(report.meetings.map((meeting) => [meeting.id, meeting])); const labels = new Map(report.labels.map((label) => [label.id, label.name]));
  const rows: Record<string, unknown>[] = report.members.flatMap((item) => item.rows.flatMap((row: any) => {
    const meeting = meetings.get(row.meetingId); if (!meeting) return []; const date = meeting.startsAt.slice(0, 10); const week = item.weeks.find((week: any) => week.segmentStartsOn <= date && date <= week.segmentEndsOn); const policy = item.currentCompliance;
    return [{ meeting: meeting.title, meetingStart: meeting.startsAt, meetingEnd: meeting.endsAt, audience: row.audience, required: Boolean(meeting.required), attendanceWeight: meeting.attendanceWeight, memberId: item.member.memberId, firstName: item.member.firstName, lastName: item.member.lastName, memberLabels: row.memberLabelIds.map((id: string) => labels.get(id) ?? "Retired label").join("; "), disposition: row.disposition, eligibility: row.eligibility, regularEligible: row.regularEligible, regularWeight: row.regularWeight, regularWeightedPresent: row.regularEligible && row.attended ? row.regularWeight : 0, regularRate: item.regularAttendance.rate ?? "", regularAttended: item.regularAttendance.attended, regularRequired: item.regularAttendance.required, regularFrom: item.regularAttendance.from ?? "", regularTo: item.regularAttendance.to, policyEligible: row.rateEligible, policyWeight: row.weight, policyWeightedPresent: row.rateEligible && row.attended ? row.weight : 0, policyLabel: policy.labelName ?? "", policyRuleType: policy.ruleType ?? "", policyExcusedHandling: policy.excusedHandling ?? "", policyStatus: policy.status, policyTarget: policy.threshold ?? "", policyAttended: policy.attended, policyRequired: policy.required, policyRate: policy.rate ?? "", policyFrom: policy.status === "no_rule" ? "" : policy.from, policyTo: policy.status === "no_rule" ? "" : policy.to, policyResults: JSON.stringify(item.currentCompliances), policyHistory: JSON.stringify(item.historySummaries), weeklyTarget: week?.target ?? "", weekStartsOn: week?.weekStartsOn ?? "", weekSegmentStartsOn: week?.segmentStartsOn ?? "", weekSegmentEndsOn: week?.segmentEndsOn ?? "", checkedInAt: row.checkedInAt, checkedOutAt: row.checkedOutAt, reason: row.reason }];
  }));
  return [exportHeaders.join(","), ...rows.map((row) => exportHeaders.map((header) => cell(row[header])).join(","))].join("\r\n") + "\r\n";
}
const trendAsBefore = (report: FullReport) => report.meetings.map((meeting) => { const rows = report.members.flatMap((member) => member.rows.filter((row: any) => row.meetingId === meeting.id && row.regularEligible)); const attended = rows.reduce((sum: number, row: any) => sum + (row.attended ? row.regularWeight : 0), 0); const eligible = rows.reduce((sum: number, row: any) => sum + row.regularWeight, 0); return { meetingId: meeting.id, title: meeting.title, startsAt: meeting.startsAt, rate: eligible > 0 ? Math.round(attended / eligible * 100) : null }; }).filter((point) => point.rate !== null);

test("the export, the leaderboard and summary reports answer as before, and again on the same loaded data", async () => {
  const database = new Database();
  try {
    for (const sql of referenceInstallationSql({ ...referenceShape, members: 25, labels: 3, kiosks: 1, meetingsPerSeason: 14, seasons: 1, attendeesPerMeeting: 5, correctionsPerMeeting: 2, noticeRecipientsPerMeeting: 2, auditEntries: 1, deliveries: 1 })) database.sqlite.exec(sql);
    // A weekly policy, a percentage policy that counts excused meetings as missed, and a label with none. A title and a
    // reason that need quoting, and a title that a spreadsheet would read as a formula.
    database.sqlite.exec(`INSERT INTO label_attendance_rules(id,installation_id,label_id,starts_on,ends_on,rule_type,threshold_percent,meetings_per_week,excused_handling,created_by,created_at,updated_at)
      SELECT 'test-rule-weekly','primary',id,'2024-09-01','2024-12-31','weekly_count',NULL,2,'exclude','admin','2024-08-15','2024-08-15' FROM member_labels WHERE name='Test Label 1'
      UNION ALL SELECT 'test-rule-rate','primary',id,NULL,NULL,'weighted_percentage',75,NULL,'count_missed','admin','2024-08-15','2024-08-15' FROM member_labels WHERE name='Test Label 2';
      UPDATE meetings SET title='Test "quoted", meeting' WHERE id=(SELECT id FROM meetings WHERE id LIKE 'test-meeting-%' ORDER BY starts_at LIMIT 1);
      UPDATE meetings SET title='=Test formula meeting', attendance_weight=2, required=0 WHERE id=(SELECT id FROM meetings WHERE id LIKE 'test-meeting-%' ORDER BY starts_at LIMIT 1 OFFSET 1);
      UPDATE attendance_corrections SET reason='Test reason, with a comma' WHERE id=(SELECT id FROM attendance_corrections ORDER BY id LIMIT 1);`);
    const fetch = await client(database); const json = async (path: string) => { const result = await fetch(path); assert.equal(result.status, 200, path); return result.json() as Promise<any>; };
    for (const filter of ["", "?roster=all", "?from=2024-09-04&to=2024-09-10", "?meetingType=required&from=2024-09-02", "?meetingType=optional&roster=all"]) {
      const join = filter ? "&" : "?";
      for (const round of ["first", "again"]) {
        const full = await json(`/reports/attendance${filter}`) as FullReport;
        assert.ok(full.members.length > 5 && full.members.some((member) => member.rows.length > 0), `${filter}: the report has rows`);
        assert.equal(await (await fetch(`/exports/attendance.csv${filter}`)).text(), exportAsBefore(full), `export ${filter}, ${round}`);
        const board = await json(`/reports/leaderboard${filter}${join}pageSize=100`);
        assert.deepEqual(board.insights.trend, trendAsBefore(full), `trend ${filter}, ${round}`);
        assert.deepEqual([...board.members].sort((a: any, b: any) => a.member.id.localeCompare(b.member.id)), [...full.members].sort((a, b) => a.member.id.localeCompare(b.member.id)), `leaderboard members ${filter}, ${round}`);
        // Summary detail is the same answer without each member's rows.
        const summary = await json(`/reports/attendance${filter}${join}detail=summary`);
        assert.deepEqual(summary, { ...full, members: full.members.map(({ rows: _rows, ...rest }) => rest) }, `summary ${filter}, ${round}`);
        const summaryBoard = await json(`/reports/leaderboard${filter}${join}pageSize=100&detail=summary`);
        assert.deepEqual(summaryBoard, { ...board, members: board.members.map(({ rows: _rows, ...rest }: any) => rest) }, `leaderboard summary ${filter}, ${round}`);
      }
    }
    assert.equal((await fetch("/reports/attendance?detail=rows")).status, 400);
    assert.equal((await fetch("/reports/leaderboard?detail=")).status, 400);
    // The export is not all header: a weekly cell, a quoted title, a guarded formula and a quoted reason are present.
    const csv = await (await fetch("/exports/attendance.csv?roster=all")).text();
    for (const expected of ['"Test ""quoted"", meeting"', "'=Test formula meeting", '"Test reason, with a comma"', "weekly_count", "count_missed"]) assert.ok(csv.includes(expected), expected);
  } finally { database.sqlite.close(); }
});
