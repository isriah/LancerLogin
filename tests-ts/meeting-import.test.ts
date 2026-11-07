// quick-check: covers apps/api/migrations/**
// POST /meetings/import on a real migrated SQLite database through the Worker: dry runs, partial commits, matches, overlaps,
// daylight-saving errors, roles, the row limit, the Free-plan query budget, queued calendar delivery and skipped Discord
// absence notices for meetings that have already ended. All data is synthetic.
import test from "node:test";
import assert from "node:assert/strict";

const { default: worker } = await import("../apps/api/src/index.ts");
const { BackupDatabase, sessionSecret } = await import("./fixtures/backup-database.ts");
const { createSessionCodec } = await import("../apps/api/src/runtime-security.ts");
const { encryptIntegration } = await import("../apps/api/src/integration-crypto.ts");

type Row = { rowNumber: number; action: string; past: boolean; error?: string; changes?: string[]; meeting?: Record<string, unknown>; existing?: Record<string, unknown> };
type Result = { rows: Row[]; summary: Record<string, number>; imported?: { added: number; updated: number; meetingIds: string[] }; calendar?: { googleQueued: number; discordQueued: number } };

const day = 86_400_000;
const iso = (offsetDays: number, hour: number, minute = 0) => { const date = new Date(Date.now() + offsetDays * day); date.setUTCHours(hour, minute, 0, 0); return date.toISOString(); };
const usDate = (value: string) => `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
const row = (rowNumber: number, values: Record<string, string>) => ({ rowNumber, values });

function fixture(timeZone = "UTC") {
  const db = new BackupDatabase(); const env = { DB: db, SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, APP_MODE: "configured" };
  db.raw.prepare("UPDATE organization_settings SET time_zone = ?, late_scan_minutes = 30").run(timeZone);
  db.raw.exec(`INSERT INTO member_labels(id,installation_id,name,active,created_at) VALUES ('label-a','primary','Test Label A',1,'2026-01-01'),('label-b','primary','Test Label B',1,'2026-01-01'),('label-c','primary','Test Label C',0,'2026-01-01');
    INSERT INTO meeting_weight_categories(id,installation_id,name,weight,position,active,minimum_duration_minutes,created_by,created_at,updated_at) VALUES ('weight-long','primary','Test Long Session',2,0,1,180,'admin','2026-01-01','2026-01-01'),('weight-old','primary','Test Old Category',1,1,0,NULL,'admin','2026-01-01','2026-01-01');
    INSERT INTO platform_module_assignments(installation_id,user_id,module_id,capabilities_json) VALUES ('primary','operator','attendance','["attendance.manage"]');`);
  // Statements in each batch: on workspace routes every read is also a batch, with Core's module guard statements.
  const batches: string[][] = []; const batch = db.batch.bind(db);
  (db as { batch: typeof db.batch }).batch = async (statements) => { batches.push((statements as unknown as { sql: string }[]).map((statement) => statement.sql)); return batch(statements); };
  let started: Promise<unknown> | undefined;
  const call = async (body: unknown, role: "admin" | "operator" | null = "admin") => {
    await (started ??= worker.fetch(new Request("https://fixture.test/health"), env as never).then(() => { db.batches = 0; db.reads = 0; }));
    const cookie = role ? "lancerlogin_session=" + await createSessionCodec(sessionSecret).issue({ userId: role, role }) : "";
    return worker.fetch(new Request("https://fixture.test/meetings/import", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), env as never);
  };
  const run = async (body: unknown) => { const result = await call(body); assert.equal(result.status, 200, await result.clone().text()); return await result.json() as Result; };
  const meeting = (id: string, title: string, startsAt: string, endsAt: string, extra = "") => db.raw.exec(`INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at${extra ? ",notes" : ""}) VALUES ('${id}','primary','${title}','${startsAt}','${endsAt}',1,'admin','2026-01-01'${extra ? `,'${extra}'` : ""});`);
  const writes = () => batches.filter((sqls) => sqls.some((sql) => /^INSERT INTO (meetings|audit_log|discord_attendance_notifications) |^UPDATE meetings /.test(sql)));
  return { db, env, call, run, meeting, writes };
}

test("a dry run classifies adds, matches, past meetings and problems without writing anything", async (t) => {
  const f = fixture(); t.after(() => f.db.raw.close());
  const date = iso(7, 18).slice(0, 10);
  f.meeting("strategy", "Test Strategy Meeting", iso(5, 18), iso(5, 19, 30));
  f.meeting("planning", "Test Outreach Planning", iso(14, 18), iso(14, 19, 30), "Synthetic");
  const before = f.db.count("SELECT COUNT(*) AS n FROM meetings");
  const result = await f.run({ dryRun: true, actions: { 6: "update" }, rows: [
    row(2, { title: "Test Build Session", date: usDate(date), startTime: "18:00", endTime: "20:30", attendance: "Required", audience: "" }),
    row(3, { title: "Test Drive Practice", date: iso(8, 0).slice(0, 10), startTime: "3:30 PM", endTime: "", duration: "2h", attendance: "Optional", audience: "test label a" }),
    row(4, { title: "Test Kickoff Review", date: usDate(iso(-7, 0).slice(0, 10)), startTime: "18:00", endTime: "20:00", attendance: "yes", audience: "" }),
    row(5, { title: "test strategy meeting", date: usDate(iso(5, 0).slice(0, 10)), startTime: "6:00 PM", endTime: "19:30", attendance: "", audience: "" }),
    row(6, { title: "Test Outreach Planning", date: usDate(iso(14, 0).slice(0, 10)), startTime: "18:00", endTime: "20:00", attendance: "Required", audience: "" }),
    row(7, { title: "Test Scrimmage Prep", date: usDate(date), startTime: "19:00", endTime: "21:00", attendance: "Required", audience: "Test Label B" }),
    row(8, { title: "Test Unknown Label", date: usDate(iso(20, 0).slice(0, 10)), startTime: "18:00", duration: "90", audience: "Test Label Z" }),
    row(9, { title: "Test Retired Label", date: usDate(iso(21, 0).slice(0, 10)), startTime: "18:00", duration: "1:30", audience: "Test Label C" }),
    row(10, { title: "Test Bad Date", date: "13/11/2026", startTime: "18:00", duration: "1h30m" }),
    row(11, { title: "Test Old Weight", date: usDate(iso(22, 0).slice(0, 10)), startTime: "18:00", duration: "60", weight: "Test Old Category" }),
  ] });
  const byRow = new Map(result.rows.map((item) => [item.rowNumber, item]));
  assert.deepEqual(result.rows.map((item) => item.action), ["add", "add", "add", "skip", "update", "error", "error", "error", "error", "error"]);
  assert.equal(byRow.get(3)!.meeting!.endTime, "17:30"); assert.deepEqual(byRow.get(3)!.meeting!.audience, ["Test Label A"]); assert.equal(byRow.get(3)!.meeting!.required, false);
  assert.equal(byRow.get(4)!.past, true);
  assert.deepEqual(byRow.get(5)!.changes, ["title"], "a case-only title difference still matches; Skip is the default");
  assert.deepEqual(byRow.get(6)!.changes, ["end time"], "an absent Notes column keeps the meeting's notes"); assert.equal(byRow.get(6)!.existing!.endTime, "19:30"); assert.equal(byRow.get(6)!.meeting!.endTime, "20:00");
  assert.equal(byRow.get(7)!.error, "Overlaps Test Build Session (6:00–8:30 PM)");
  assert.equal(byRow.get(8)!.error, "Unknown audience label Test Label Z");
  assert.equal(byRow.get(9)!.error, "Audience label Test Label C is retired");
  assert.match(byRow.get(10)!.error!, /13\/11\/2026 looks like day\/month\. Use MM\/DD\/YYYY, such as 11\/13\/2026/);
  assert.equal(byRow.get(11)!.error, "Weight category Test Old Category is retired");
  assert.deepEqual(result.summary, { add: 3, update: 1, skip: 1, error: 5, past: 1 });
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM meetings"), before); assert.equal(f.writes().length, 0);
});

test("a commit writes every row without a problem in one batch, with one import audit and the editor's update path", async (t) => {
  const f = fixture(); t.after(() => f.db.raw.close());
  f.meeting("planning", "Test Outreach Planning", iso(14, 18), iso(14, 19, 30));
  const result = await f.run({ dryRun: false, actions: { 3: "update" }, rows: [
    row(2, { title: "Test Long Build", date: usDate(iso(9, 0).slice(0, 10)), startTime: "17:00", endTime: "21:00", audience: "Test Label A;Test Label B", notes: "Synthetic" }),
    row(3, { title: "Test Outreach Planning", date: usDate(iso(14, 0).slice(0, 10)), startTime: "18:00", endTime: "20:00", audience: "Test Label B" }),
    row(4, { title: "Test Clash", date: usDate(iso(9, 0).slice(0, 10)), startTime: "18:00", endTime: "19:00" }),
  ] });
  assert.deepEqual(result.rows.map((item) => item.action), ["add", "update", "error"]);
  assert.deepEqual(result.imported && { added: result.imported.added, updated: result.imported.updated }, { added: 1, updated: 1 });
  assert.equal(f.writes().length, 1, "meetings, updates and the audit are one batch");
  const added = f.db.rows<Record<string, unknown>>("SELECT id, title, required, notes, weight_category_id AS weight, attendance_weight AS attendanceWeight, audience_mode AS audienceMode FROM meetings WHERE title = 'Test Long Build'")[0]!;
  assert.deepEqual({ ...added, id: undefined }, { id: undefined, title: "Test Long Build", required: 1, notes: "Synthetic", weight: "weight-long", attendanceWeight: 2, audienceMode: "labels" }, "a blank weight is automatic by duration");
  assert.deepEqual(f.db.rows("SELECT label_id FROM meeting_audience_labels WHERE meeting_id = ? ORDER BY label_id", added.id).map((item) => item.label_id), ["label-a", "label-b"]);
  assert.deepEqual(f.db.rows("SELECT ends_at, audience_mode FROM meetings WHERE id = 'planning'"), [{ ends_at: iso(14, 20), audience_mode: "labels" }]);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM meetings WHERE title = 'Test Clash'"), 0);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'meetings.imported'"), 1);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'meeting.updated' AND target_id = 'planning'"), 1);
  // A commit rechecks: a matched row the caller did not choose to update is skipped, and an all-problem file writes nothing.
  const recheck = await f.call({ dryRun: false, rows: [row(2, { title: "Test Clash", date: usDate(iso(9, 0).slice(0, 10)), startTime: "18:00", endTime: "19:00" })] });
  assert.equal(recheck.status, 400); assert.equal(f.writes().length, 1);
});

test("rows overlapping each other and repeated rows are errors; an earlier row wins", async (t) => {
  const f = fixture(); t.after(() => f.db.raw.close());
  const date = usDate(iso(10, 0).slice(0, 10));
  const result = await f.run({ dryRun: true, rows: [
    row(2, { title: "Test A", date, startTime: "09:00", endTime: "10:00" }),
    row(3, { title: "Test B", date, startTime: "10:15", endTime: "11:00" }),
    row(4, { title: "Test A", date, startTime: "09:00", endTime: "10:00" }),
    row(5, { title: "Test C", date, startTime: "22:00", endTime: "01:00" }),
  ] });
  assert.deepEqual(result.rows.map((item) => [item.action, item.error]), [["add", undefined], ["error", "Overlaps Test A (9:00–10:00 AM)"], ["error", "Repeats row 2"], ["add", undefined]]);
  assert.equal(result.rows[3]!.meeting!.endDate, iso(11, 0).slice(0, 10), "an end at or before the start is the next day");
});

test("nonexistent and repeated daylight-saving times are row errors in the organization time zone", async (t) => {
  const f = fixture("America/Los_Angeles"); t.after(() => f.db.raw.close());
  const result = await f.run({ dryRun: true, rows: [
    row(2, { title: "Test Spring", date: "03/08/2026", startTime: "2:30 AM", duration: "60" }),
    row(3, { title: "Test Fall", date: "2026-11-01", startTime: "01:30", duration: "30" }),
    row(4, { title: "Test Evening", date: "11/01/2026", startTime: "18:00", endTime: "20:00" }),
  ] });
  assert.match(result.rows[0]!.error!, /2:30 AM on 03\/08\/2026 in America\/Los_Angeles doesn't exist/);
  assert.match(result.rows[1]!.error!, /1:30 AM on 11\/01\/2026 in America\/Los_Angeles happens twice/);
  assert.equal(result.rows[2]!.action, "add");
});

test("Admins and Operators may import; others are refused; at most 200 rows", async (t) => {
  const f = fixture(); t.after(() => f.db.raw.close());
  const body = { dryRun: true, rows: [row(2, { title: "Test Role", date: usDate(iso(3, 0).slice(0, 10)), startTime: "18:00", duration: "60" })] };
  assert.equal((await f.call(body, null)).status, 401);
  assert.equal((await f.call(body, "operator")).status, 200);
  const tooMany = await f.call({ dryRun: true, rows: Array.from({ length: 201 }, (_, index) => row(index + 2, { title: `Test ${index}`, date: "11/10/2026", startTime: "18:00", duration: "60" })) });
  assert.equal(tooMany.status, 400); assert.match(await tooMany.text(), /no more than 200/);
});

test("200 rows commit within the Free plan's query budget and queue calendar delivery for the scheduled jobs", async (t) => {
  const f = fixture(); t.after(() => f.db.raw.close());
  const encrypted = await encryptIntegration({ botToken: "synthetic-token", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  f.db.raw.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES ('discord-1','primary','discord',?,?,'2026-01-01','2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
  f.db.raw.exec("UPDATE installations SET discord_enabled = 1");
  // Skip today: a meeting today at 18:00-19:00 UTC is future or past depending on when the test runs.
  const rows = Array.from({ length: 200 }, (_, index) => row(index + 2, { title: `Test Meeting ${index}`, date: usDate(iso(index < 20 ? index - 21 : index - 19, 0).slice(0, 10)), startTime: "18:00", endTime: "19:00", audience: index % 2 ? "Test Label A" : "" }));
  await f.call({ dryRun: true, rows: rows.slice(0, 1) });
  const reads = f.db.reads; const originalFetch = globalThis.fetch; let provider = 0;
  globalThis.fetch = async () => { provider += 1; return new Response("{}"); };
  const started = performance.now();
  let result: Result;
  try { result = await f.run({ dryRun: false, rows }); } finally { globalThis.fetch = originalFetch; }
  const elapsed = performance.now() - started;
  assert.equal(result.imported!.added, 200); assert.equal(provider, 0, "no provider call inline");
  // D1 counts a batch as one query. Reads include session and module checks made for every request.
  const queries = f.db.reads - reads + f.db.batches;
  assert.ok(queries <= 15, `commit used ${queries} D1 queries`);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM discord_calendar_operations WHERE status = 'pending'"), 180, "future meetings only");
  assert.equal(result.calendar!.discordQueued, 180);
  assert.equal(f.db.count("SELECT COUNT(*) AS n FROM discord_attendance_notifications WHERE status = 'skipped'"), 20);
  console.log(`200-row commit: ${queries} D1 queries, ${elapsed.toFixed(1)} ms wall time in Node (includes SQLite)`);
});

test("imported meetings that have ended get skipped notices, so the absence job posts nothing for them", async (t) => {
  const f = fixture(); t.after(() => f.db.raw.close());
  const encrypted = await encryptIntegration({ botToken: "synthetic-token", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  f.db.raw.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES ('discord-1','primary','discord',?,?,'2026-01-01','2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
  f.db.raw.exec("UPDATE installations SET discord_enabled = 1; UPDATE members SET discord_user_id = '323456789012345678';");
  f.meeting("moving", "Test Moving Meeting", iso(2, 18), iso(2, 20));
  const result = await f.run({ dryRun: false, actions: { 3: "update" }, rows: [
    row(2, { title: "Test Past Build", date: usDate(iso(-3, 0).slice(0, 10)), startTime: "18:00", endTime: "20:00" }),
    row(3, { title: "Test Moving Meeting", date: usDate(iso(2, 0).slice(0, 10)), startTime: "18:00", endTime: "20:00", notes: "Synthetic" }),
  ] });
  assert.equal(result.summary.past, 1);
  assert.deepEqual(f.db.rows("SELECT m.title, n.status FROM discord_attendance_notifications n JOIN meetings m ON m.id = n.meeting_id"), [{ title: "Test Past Build", status: "skipped" }]);
  // A meeting added outside the import, with no notice row, is the control: the job does post for it.
  f.meeting("control", "Test Control Meeting", iso(-2, 18), iso(-2, 19));
  const originalFetch = globalThis.fetch; const posted: string[] = [];
  globalThis.fetch = async (input, init) => { const url = String(input instanceof Request ? input.url : input); if ((init?.method ?? "GET") === "POST" && url.endsWith("/messages")) posted.push(String(JSON.parse(String(init!.body)).content)); return new Response(JSON.stringify({ id: `message-${posted.length}` }), { headers: { "content-type": "application/json" } }); };
  try { await worker.scheduled({ cron: "*/5 * * * *" }, f.env as never); } finally { globalThis.fetch = originalFetch; }
  assert.equal(posted.filter((content) => content.includes("Test Past Build")).length, 0);
  assert.equal(posted.filter((content) => content.includes("Test Control Meeting")).length, 1);
});

test("an update that moves a meeting into the past writes a skipped notice; attendance changes to completed meetings are refused", async (t) => {
  const f = fixture(); t.after(() => f.db.raw.close());
  f.meeting("ending", "Test Ending Meeting", iso(0, 0, 0), new Date(Date.now() + 10 * 60_000).toISOString());
  f.meeting("closed", "Test Closed Meeting", iso(-5, 18), iso(-5, 19));
  const start = new Date(Date.parse(iso(0, 0, 0)));
  const result = await f.run({ dryRun: false, actions: { 2: "update", 3: "update" }, rows: [
    row(2, { title: "Test Ending Meeting", date: usDate(start.toISOString().slice(0, 10)), startTime: "00:00", duration: "1" }),
    row(3, { title: "Test Closed Meeting", date: usDate(iso(-5, 0).slice(0, 10)), startTime: "18:00", endTime: "19:00", attendance: "Optional" }),
  ] });
  assert.equal(result.rows[0]!.action, "update"); assert.equal(result.rows[0]!.past, true);
  assert.match(result.rows[1]!.error!, /completed meeting/);
  assert.deepEqual(f.db.rows("SELECT meeting_id, status FROM discord_attendance_notifications"), [{ meeting_id: "ending", status: "skipped" }]);
});
