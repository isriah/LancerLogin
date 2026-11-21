// The Free-plan scheduler against real SQL: one slice per invocation within its budget, re-arming while work remains,
// Discord's 60-day event horizon, a Stop that pauses every delivery and expires after 24 hours, scheduler status on a
// deployment with no Durable Object, and the cron as a watchdog only. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { PlatformScheduler, registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, runSchedulerSlice, type Env } from "../apps/api/src/index.ts";
import { SCHEDULER_STOP_MS, SLICE_CONTINUE_MS, SLICE_IDLE_MAX_MS } from "../apps/api/src/platform-scheduler.ts";
import { scheduledPassLimits, scheduledSliceLimits } from "../apps/api/src/scheduler-budget.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { InstallationSeed, TestD1Database, attendanceWithOutreachDisabled } from "./fixtures/d1-database.ts";
import { sessionSecret } from "./fixtures/worker-fake-database.ts";
import { countingDatabase } from "./fixtures/counting-database.ts";

const jobIds = [...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs].map((job) => job.id);
const guildId = "123456789012345678";
const day = 86_400_000;

async function installation() {
  const db = new TestD1Database({ seed: new InstallationSeed("2026-09-01T00:00:00Z").users("admin").organization().modules(...attendanceWithOutreachDisabled(true)) });
  const discord = await encryptIntegration({ botToken: "synthetic-bot-token", guildId, channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  db.sqlite.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,verified_at,updated_at) VALUES ('discord-1','primary','discord',?,?,'2026-09-01','2026-09-01')").run(discord.ciphertext, discord.iv);
  db.sqlite.exec("UPDATE installations SET discord_enabled = 1 WHERE id = 'primary'");
  const env = { APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: db } as unknown as Env;
  return { db, env };
}

/** Every job's state set to "not due for an hour", so a test runs only the job it pokes or makes due. */
function quietJobs(db: TestD1Database, now = Date.now()) {
  const jobs = Object.fromEntries(jobIds.map((id) => [id, { next: now + 3_600_000, last: now - 60_000, outcome: "ok" }]));
  db.sqlite.prepare("INSERT INTO platform_scheduler_state(installation_id,jobs_json,updated_at) VALUES ('primary',?,?) ON CONFLICT(installation_id) DO UPDATE SET jobs_json = excluded.jobs_json").run(JSON.stringify(jobs), new Date(now).toISOString());
}

let meetingNumber = 0;
/** A synthetic meeting with a pending Discord calendar upsert, `daysAhead` from now. */
function meetingWithPendingEvent(db: TestD1Database, daysAhead: number, eventId: string | null = null) {
  const id = `meeting-${++meetingNumber}`; const start = new Date(Date.now() + daysAhead * day);
  db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES (?,'primary',?,?,?,'admin','2026-09-01T00:00:00Z')").run(id, `Test Meeting ${meetingNumber}`, start.toISOString(), new Date(start.getTime() + 7_200_000).toISOString());
  db.sqlite.prepare("INSERT INTO discord_calendar_event_mappings(installation_id,meeting_id,event_id,generation,active,updated_at) VALUES ('primary',?,?,1,1,'2026-09-01')").run(id, eventId);
  db.sqlite.prepare("INSERT INTO discord_calendar_operations(installation_id,meeting_id,generation,action,event_id,status,attempts,next_attempt_at,updated_at) VALUES ('primary',?,1,'upsert',NULL,'pending',0,'2026-09-01',?)").run(id, `2026-09-01T00:00:${String(meetingNumber % 60).padStart(2, "0")}Z`);
  return id;
}

/** Discord stand-in: lists no events, creates numbered ones, accepts everything else; records each request. */
async function withDiscord<T>(work: (requests: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch; const requests: string[] = []; let created = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? "GET"; requests.push(`${method} ${url.replace("https://discord.com/api/v10", "")}`);
    if (url.endsWith("/scheduled-events") && method === "GET") return Response.json([]);
    if (url.endsWith("/scheduled-events") && method === "POST") return Response.json({ id: `event-${++created}` });
    return Response.json({ id: "message-1" });
  }) as typeof fetch;
  try { return await work(requests); } finally { globalThis.fetch = original; }
}
const cpuMs = () => { const usage = process.cpuUsage(); return (usage.user + usage.system) / 1_000; };
const operationStatus = (db: TestD1Database, meetingId: string) => (db.sqlite.prepare("SELECT status FROM discord_calendar_operations WHERE meeting_id = ? AND action = 'upsert'").get(meetingId) as { status: string }).status;
const cookie = async () => `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "admin", role: "admin" })}`;
const call = async (env: Env, path: string, method = "GET") => worker.fetch(new Request(`https://api.example.test${path}`, { method, headers: { cookie: await cookie(), ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) }), env);

test("each slice runs one job's small batch within the slice budget and re-arms while work remains", async (t) => {
  const { db, env } = await installation(); quietJobs(db);
  const meetings = Array.from({ length: 8 }, (_, index) => meetingWithPendingEvent(db, 2 + index));
  const slices: { attempted: string[]; d1: number; external: number; cpuMs: number; more: boolean }[] = [];
  await withDiscord(async (requests) => {
    let pokes: Record<string, number> = { "attendance.discord-calendar": Date.now() }; let now = Date.now();
    for (let index = 0; index < 10; index += 1) {
      // Each slice runs when the previous one asked to be woken.
      const before = cpuMs(); const report = await runSchedulerSlice(env, pokes, now); const spent = cpuMs() - before;
      slices.push({ attempted: report.attempted, d1: report.d1Queries, external: report.externalRequests, cpuMs: Math.round(spent * 10) / 10, more: Boolean(report.more) });
      if (!report.more) break;
      assert.equal(report.nextWake, now + SLICE_CONTINUE_MS, "more work asks for the next slice within a second");
      pokes = {}; now = report.nextWake;
    }
    assert.equal(requests.filter((line) => line.startsWith("POST") && line.endsWith("/scheduled-events")).length, 8);
  });
  t.diagnostic(`slices: ${JSON.stringify(slices)}`);
  assert.ok(slices.every((slice) => slice.attempted.length === 1 && slice.attempted[0] === "attendance.discord-calendar"), "exactly one job per slice");
  assert.ok(slices.every((slice) => slice.d1 <= scheduledSliceLimits.d1 && slice.external <= scheduledSliceLimits.external), "every slice within its budget");
  assert.ok(slices.every((slice) => slice.d1 < 50 && slice.external < 50));
  assert.ok(slices.length >= 3 && slices.at(-1)!.more === false, "the backlog drains over several slices");
  assert.deepEqual(meetings.map((id) => operationStatus(db, id)), meetings.map(() => "delivered"));
  const state = JSON.parse((db.sqlite.prepare("SELECT jobs_json AS jobs FROM platform_scheduler_state").get() as { jobs: string }).jobs);
  assert.equal(state["attendance.discord-calendar"].outcome, "ok");
  assert.ok(state["attendance.discord-calendar"].next > Date.now() + 200_000, "a drained job waits its interval");
});

test("an idle slice costs one batched read and nothing else", async () => {
  const { db, env } = await installation(); quietJobs(db);
  const report = await runSchedulerSlice(env, {});
  assert.deepEqual(report.attempted, []); assert.equal(report.d1Queries, 1); assert.equal(report.externalRequests, 0);
  // Nothing is due for an hour, so it sleeps for the idle cap (five minutes) and checks again.
  assert.ok(report.nextWake > Date.now() + SLICE_IDLE_MAX_MS - 5_000 && report.nextWake <= Date.now() + SLICE_IDLE_MAX_MS);
});

test("Discord sync only creates events for meetings starting within 60 days; later ones wait and enter as they come in range", async () => {
  const { db, env } = await installation(); quietJobs(db);
  const soon = meetingWithPendingEvent(db, 10), later = meetingWithPendingEvent(db, 90), mapped = meetingWithPendingEvent(db, 120, "existing-event");
  await withDiscord(async (requests) => {
    await runSchedulerSlice(env, { "attendance.discord-calendar": Date.now() });
    assert.equal(operationStatus(db, soon), "delivered");
    assert.equal(operationStatus(db, later), "pending", "beyond the horizon, no event is created");
    assert.equal(operationStatus(db, mapped), "delivered", "a meeting that already has an event keeps it in sync");
    assert.equal(requests.filter((line) => line.startsWith("POST")).length, 1);
    assert.ok(requests.some((line) => line === `PATCH /guilds/${guildId}/scheduled-events/existing-event`));
    // Time passes: the meeting is now 59 days away.
    db.sqlite.prepare("UPDATE meetings SET starts_at = ?, ends_at = ? WHERE id = ?").run(new Date(Date.now() + 59 * day).toISOString(), new Date(Date.now() + 59 * day + 7_200_000).toISOString(), later);
    quietJobs(db); await runSchedulerSlice(env, { "attendance.discord-calendar": Date.now() });
    assert.equal(operationStatus(db, later), "delivered");
    assert.equal(requests.filter((line) => line.startsWith("POST")).length, 2);
  });
});

test("Stop pauses all outbound delivery, first attempts included, shows when it resumes, and expires after 24 hours", async () => {
  const { db, env } = await installation(); quietJobs(db);
  const meetingId = meetingWithPendingEvent(db, 5);
  await withDiscord(async (requests) => {
    const stopped = await call(env, "/admin/scheduler/stop", "POST");
    assert.equal(stopped.status, 200);
    const status = await stopped.json() as { enabled: boolean; mode: string; pausedUntil: string; jobs: Record<string, unknown> };
    assert.equal(status.enabled, false); assert.equal(status.mode, "cron");
    const resumes = Date.parse(status.pausedUntil);
    assert.ok(Math.abs(resumes - (Date.now() + SCHEDULER_STOP_MS)) < 5_000, "the Stop lasts 24 hours");
    assert.deepEqual(Object.keys(status.jobs).sort(), [...jobIds].sort());
    // A first attempt from a request is held, not sent.
    const first = await worker.fetch(new Request("https://api.example.test/discord/calendar", { method: "POST", headers: { cookie: await cookie(), "content-type": "application/json" }, body: JSON.stringify({ meetingId }) }), env);
    assert.equal(first.status, 200); assert.equal((await first.json() as { queued: number }).queued, 1);
    // A slice skips every delivery job, even one poked or overdue; internal housekeeping still runs.
    db.sqlite.exec("UPDATE platform_scheduler_state SET jobs_json = json_set(jobs_json, '$.\"attendance.discord-calendar\".next', 0, '$.\"core.housekeeping\".next', 0)");
    const held = await runSchedulerSlice(env, { "attendance.discord-calendar": Date.now() });
    assert.deepEqual(held.attempted, ["core.housekeeping"]);
    const idle = await runSchedulerSlice(env, { "attendance.discord-calendar": Date.now() });
    assert.deepEqual(idle.attempted, []); assert.ok(idle.nextWake <= resumes, "the alarm wakes by the time the Stop expires");
    assert.equal(requests.length, 0, "nothing reached Discord while stopped");
    assert.equal(operationStatus(db, meetingId), "pending");
    // A manual "send missing notice" is refused clearly rather than silently held.
    const past = meetingWithPendingEvent(db, -1);
    const manual = await worker.fetch(new Request("https://api.example.test/discord/missing", { method: "POST", headers: { cookie: await cookie(), "content-type": "application/json" }, body: JSON.stringify({ meetingId: past }) }), env);
    assert.equal(manual.status, 409); assert.match((await manual.json() as { error: string }).error, /stopped until/);
    // 24 hours later the Stop has expired by itself: status reads Running and the held work goes out.
    db.sqlite.prepare("UPDATE platform_scheduler_state SET paused_until = ?").run(new Date(Date.now() - 1_000).toISOString());
    const expired = await (await call(env, "/admin/scheduler")).json() as { enabled: boolean; pausedUntil: string | null };
    assert.deepEqual([expired.enabled, expired.pausedUntil], [true, null]);
    const resumed = await runSchedulerSlice(env, { "attendance.discord-calendar": Date.now() });
    assert.deepEqual(resumed.attempted, ["attendance.discord-calendar"]);
    assert.equal(operationStatus(db, meetingId), "delivered");
  });
  // Start ends a Stop early.
  await call(env, "/admin/scheduler/stop", "POST");
  const started = await (await call(env, "/admin/scheduler/start", "POST")).json() as { enabled: boolean };
  assert.equal(started.enabled, true);
  const audit = db.sqlite.prepare("SELECT action FROM audit_log WHERE action LIKE 'scheduler.%' ORDER BY created_at").all().map((row) => (row as { action: string }).action);
  assert.deepEqual(audit, ["scheduler.stop", "scheduler.stop", "scheduler.start"]);
});

test("scheduler status works without a Durable Object, reports the alarm with one, and stays Admin-only", async () => {
  const { db, env } = await installation();
  const cron = await call(env, "/admin/scheduler");
  assert.equal(cron.status, 200, "no 503 on a cron-only deployment");
  const body = await cron.json() as { enabled: boolean; mode: string; alarm: number | null };
  assert.deepEqual([body.enabled, body.mode, body.alarm], [true, "cron", null]);
  const operator = `lancerlogin_session=${await createSessionCodec(sessionSecret).issue({ userId: "operator", role: "operator" })}`;
  db.sqlite.exec("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('operator','primary','operator','operator','2026-09-01')");
  assert.equal((await worker.fetch(new Request("https://api.example.test/admin/scheduler", { headers: { cookie: operator } }), env)).status, 403);
  assert.equal((await worker.fetch(new Request("https://api.example.test/admin/scheduler/stop", { method: "POST", headers: { cookie: await cookie(), "content-type": "application/json" }, body: JSON.stringify({ hours: 1 }) }), env)).status, 400);
  const seen: string[] = []; const alarm = Date.now() + 90_000;
  const durable = { ...env, PLATFORM_SCHEDULER: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => { seen.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ alarm }); } }) } } as Env;
  const status = await (await call(durable, "/admin/scheduler")).json() as { mode: string; alarm: number };
  assert.deepEqual([status.mode, status.alarm], ["durable", alarm]);
  assert.deepEqual(seen, ["POST /watchdog"], "reading status re-arms a lost alarm");
  // PLATFORM_SCHEDULER_MODE "cron" keeps the cron fallback even with the binding.
  assert.equal((await (await call({ ...durable, PLATFORM_SCHEDULER_MODE: "cron" } as Env, "/admin/scheduler")).json() as { mode: string }).mode, "cron");
});

test("with the Durable Object the cron only re-arms the alarm; without it the cron runs each due job's slice", async () => {
  const { db, env } = await installation(); quietJobs(db);
  meetingWithPendingEvent(db, 3);
  let queries = 0; const counted = { prepare: (sql: string) => { queries += 1; return db.prepare(sql); }, batch: (statements: never[]) => { queries += 1; return db.batch(statements); } };
  const seen: string[] = [];
  const durable = { ...env, DB: counted, PLATFORM_SCHEDULER: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => { seen.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ alarm: 1, rearmed: true }); } }) } } as unknown as Env;
  await withDiscord(async (requests) => {
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as never, durable);
    assert.deepEqual(seen, ["POST /watchdog"]); assert.equal(queries, 0, "the watchdog does no D1 work"); assert.equal(requests.length, 0);
    // The cron fallback: due jobs run in one pass within the pass budget.
    db.sqlite.exec("UPDATE platform_scheduler_state SET jobs_json = json_set(jobs_json, '$.\"attendance.discord-calendar\".next', 0)");
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as never, env);
    assert.equal(requests.filter((line) => line.startsWith("POST")).length, 1);
  });
});

// ---- Robustness of the runner and the Discord notice and anomaly-report jobs (database-access audit, 2026-11-20) ----

const anomalyChannel = "323456789012345678", noticeChannel = "223456789012345678";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** A synthetic required meeting that ended `hoursAgo` hours ago, long past its attendance close. */
function endedMeeting(db: TestD1Database, hoursAgo: number, title: string) {
  const id = `ended-${++meetingNumber}`; const end = Date.now() - hoursAgo * 3_600_000;
  db.sqlite.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at) VALUES (?,'primary',?,?,?,1,'admin','2026-09-01T00:00:00Z')").run(id, title, new Date(end - 7_200_000).toISOString(), new Date(end).toISOString());
  return id;
}
/** Two synthetic members: A is linked to Discord and never scans (absent everywhere); B arrives 30 minutes late (an anomaly). */
function testMembers(db: TestD1Database) {
  db.sqlite.exec(`INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id,active,created_at) VALUES
    ('member-a','primary','TEST-A','Test Student','A','test-student-a@example.test','811111111111111111',1,'2026-01-01T00:00:00Z'),
    ('member-b','primary','TEST-B','Test Student','B','test-student-b@example.test',NULL,1,'2026-01-01T00:00:00Z')`);
}
function lateArrival(db: TestD1Database, meetingId: string) {
  const meeting = db.sqlite.prepare("SELECT starts_at AS startsAt, ends_at AS endsAt FROM meetings WHERE id = ?").get(meetingId) as { startsAt: string; endsAt: string };
  const event = db.sqlite.prepare("INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) VALUES (?,'primary','member-b',?,'manual',?,?)");
  event.run(`in-${meetingId}`, meetingId, new Date(Date.parse(meeting.startsAt) + 30 * 60_000).toISOString(), "check_in"); event.run(`out-${meetingId}`, meetingId, meeting.endsAt, "check_out");
}
function enableAnomalyReports(db: TestD1Database) {
  db.sqlite.prepare("UPDATE organization_settings SET discord_anomaly_reports_enabled = 1, discord_anomaly_report_channel_id = ?, discord_anomaly_reports_enabled_at = ?").run(anomalyChannel, new Date(Date.now() - 7 * day).toISOString());
}
/** Discord stand-in for messages: a message whose text contains "Failing" is refused; everything else is accepted. */
async function withMessages<T>(work: (posts: { channel: string; content: string }[], requests: string[]) => Promise<T>, onRequest?: () => void): Promise<T> {
  const original = globalThis.fetch; const posts: { channel: string; content: string }[] = []; const requests: string[] = []; let created = 5000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace("https://discord.com/api/v10", ""); const method = init?.method ?? "GET"; requests.push(`${method} ${url}`); onRequest?.();
    const message = /^\/channels\/(\d+)\/messages$/.exec(url);
    if (message && method === "POST") {
      const content = String((JSON.parse(String(init?.body ?? "{}")) as { content?: string }).content ?? "");
      posts.push({ channel: message[1]!, content });
      if (content.includes("Failing")) return Response.json({ message: "Synthetic Discord failure", code: 50_035 }, { status: 400 });
      return Response.json({ id: String(++created) });
    }
    if (url.endsWith("/scheduled-events") && method === "GET") return Response.json([]);
    if (/\/commands$/.test(url) && method === "GET") return Response.json([]);
    return Response.json({ id: method === "POST" ? String(++created) : url.split("/").pop(), pinned: true });
  }) as typeof fetch;
  try { return await work(posts, requests); } finally { globalThis.fetch = original; }
}
const reportRow = (db: TestD1Database, meetingId: string) => { const row = db.sqlite.prepare("SELECT status, attempts, last_error AS lastError FROM discord_anomaly_reports WHERE meeting_id = ?").get(meetingId) as { status: string; attempts: number; lastError: string | null } | undefined; return row && { ...row }; };
const noticeRow = (db: TestD1Database, meetingId: string) => { const row = db.sqlite.prepare("SELECT status, attempts, last_error AS lastError FROM discord_attendance_notifications WHERE meeting_id = ?").get(meetingId) as { status: string; attempts: number; lastError: string | null } | undefined; return row && { ...row }; };
const failedReport = (db: TestD1Database, meetingId: string, attempts: number, updatedMinutesAgo: number) => db.sqlite.prepare("INSERT INTO discord_anomaly_reports(installation_id,meeting_id,channel_id,status,nonce,attempts,last_error,updated_at) VALUES ('primary',?,?,'failed',?,?,'Synthetic Discord failure',?)").run(meetingId, anomalyChannel, `nonce-${meetingId}`, attempts, minutesAgo(updatedMinutesAgo));
const notice = (db: TestD1Database, meetingId: string, status: string, attempts: number, updatedMinutesAgo: number) => db.sqlite.prepare("INSERT INTO discord_attendance_notifications(installation_id,meeting_id,status,attempts,updated_at,channel_id,delivery_id) VALUES ('primary',?,?,?,?,?,?)").run(meetingId, status, attempts, minutesAgo(updatedMinutesAgo), noticeChannel, `delivery-${meetingId}`);
const due = (db: TestD1Database, ...jobs: string[]) => db.sqlite.exec(`UPDATE platform_scheduler_state SET jobs_json = json_set(jobs_json, ${jobs.map((job) => `'$."${job}".next', 0`).join(", ")})`);
const storedJob = (db: TestD1Database, job: string) => JSON.parse((db.sqlite.prepare("SELECT jobs_json AS j FROM platform_scheduler_state").get() as { j: string }).j)[job] as { next: number; last: number | null; outcome: string; cursor?: string };
const sliceHooks = (crashed?: { job: string; at: number; count?: number }) => ({ ...(crashed ? { crashed } : {}), started: async () => undefined });

test("anomaly reports: a new meeting's report goes out before reports that keep failing, and failing ones never ask for another slice", async () => {
  const { db, env } = await installation(); testMembers(db); enableAnomalyReports(db);
  // Three reports Discord refuses every time, for the three oldest meetings, and one meeting never attempted.
  const failing = [30, 29, 28].map((hours, index) => endedMeeting(db, hours, `Failing Meeting ${index + 1}`));
  const fresh = endedMeeting(db, 3, "Test Meeting New");
  for (const meetingId of [...failing, fresh]) lateArrival(db, meetingId);
  for (const meetingId of failing) failedReport(db, meetingId, 3, 10);
  await withMessages(async (posts) => {
    quietJobs(db); const now = Date.now();
    const report = await runSchedulerSlice(env, { "attendance.discord-anomalies": now }, now, sliceHooks());
    assert.deepEqual(report.attempted, ["attendance.discord-anomalies"]);
    assert.equal(reportRow(db, fresh)?.status, "delivered", "the report never attempted is sent in the first slice");
    assert.match(posts[0]!.content, /Test Meeting New/, "and before any retry");
    assert.equal(Boolean(report.more), false, "failing reports do not ask for another slice");
    assert.ok(report.nextWake >= now + 240_000, `the job waits for its interval: ${report.nextWake - now} ms`);
    assert.equal(storedJob(db, "attendance.discord-anomalies").next, now + 300_000);
    // Each failed attempt is counted, so the backoff grows.
    assert.deepEqual(failing.map((meetingId) => reportRow(db, meetingId)?.status), ["failed", "failed", "failed"]);
    assert.ok(failing.some((meetingId) => reportRow(db, meetingId)!.attempts === 4));
  });
});

test("anomaly reports: a failed report waits out its backoff and is given up after its last attempt", async () => {
  const { db, env } = await installation(); testMembers(db); enableAnomalyReports(db);
  const [recent, waited, spent] = [endedMeeting(db, 30, "Failing Meeting Recent"), endedMeeting(db, 29, "Failing Meeting Waited"), endedMeeting(db, 28, "Failing Meeting Spent")];
  for (const meetingId of [recent, waited, spent]) lateArrival(db, meetingId);
  // Ten attempts back off 1,024 seconds: one tried 5 minutes ago is not due, one tried 20 minutes ago is.
  failedReport(db, recent, 10, 5); failedReport(db, waited, 10, 20);
  // Sixteen attempts is the cap, however long ago the last one was.
  failedReport(db, spent, 16, 3 * 24 * 60);
  await withMessages(async (posts) => {
    quietJobs(db); const now = Date.now();
    const report = await runSchedulerSlice(env, { "attendance.discord-anomalies": now }, now, sliceHooks());
    assert.deepEqual(posts.map((post) => /Failing Meeting (\w+)/.exec(post.content)?.[1]), ["Waited"]);
    assert.equal(Boolean(report.more), false);
    assert.deepEqual([reportRow(db, recent)!.attempts, reportRow(db, waited)!.attempts, reportRow(db, spent)!.attempts], [10, 11, 16]);
  });
});

test("attendance notices: a notice left pending by a stopped invocation is taken up again once it is ten minutes old", async () => {
  const { db, env } = await installation(); testMembers(db);
  const stuck = endedMeeting(db, 5, "Test Meeting Stuck"), inFlight = endedMeeting(db, 4, "Test Meeting In Flight");
  notice(db, stuck, "pending", 1, 20); notice(db, inFlight, "pending", 1, 2);
  await withMessages(async (posts) => {
    quietJobs(db); const now = Date.now();
    const report = await runSchedulerSlice(env, { "attendance.discord-notices": now }, now, sliceHooks());
    assert.deepEqual(report.attempted, ["attendance.discord-notices"]);
    assert.deepEqual(posts.map((post) => /\*\*(.+)\*\*/.exec(post.content)?.[1]), ["Test Meeting Stuck"]);
    assert.deepEqual(noticeRow(db, stuck), { status: "delivered", attempts: 2, lastError: null });
    assert.equal(noticeRow(db, inFlight)?.status, "pending", "a notice written two minutes ago may still be in flight");
  });
});

test("attendance notices: a failure before the first Discord request marks the notice failed with its reason, and it is retried", async () => {
  const { db, env } = await installation(); testMembers(db);
  const meetingId = endedMeeting(db, 5, "Test Meeting Limit");
  const counted = countingDatabase(db); let failing = true;
  // The absence evaluation's roster read fails, as a query does when the invocation runs out of subrequests.
  counted.fail = (statements) => { if (failing && statements.some((sql) => sql.includes("inactive_periods_json AS inactivePeriodsJson"))) throw new Error("Too many API requests by single Worker invocation"); };
  await withMessages(async (posts) => {
    quietJobs(db); let now = Date.now();
    await runSchedulerSlice({ ...env, DB: counted } as Env, { "attendance.discord-notices": now }, now, sliceHooks());
    assert.equal(posts.length, 0);
    assert.deepEqual(noticeRow(db, meetingId), { status: "failed", attempts: 1, lastError: "Too many API requests by single Worker invocation" });
    // One attempt backs off a minute. The job's next regular run is five minutes later.
    db.sqlite.prepare("UPDATE discord_attendance_notifications SET updated_at = ?").run(minutesAgo(5));
    failing = false; quietJobs(db); now = Date.now();
    const retried = await runSchedulerSlice({ ...env, DB: counted } as Env, { "attendance.discord-notices": now }, now, sliceHooks());
    assert.equal(posts.length, 1);
    assert.deepEqual(noticeRow(db, meetingId), { status: "delivered", attempts: 2, lastError: null });
    assert.equal(Boolean(retried.more), false);
    // What the audit counted as about 18 D1 queries against 12 budgeted. This slice is its opening read (1), the job's
    // own reads (5), one notice and the closing write (1); the notice's policy reads now go out as one batch.
    assert.ok(retried.d1Queries - 7 <= 13, `one notice costs ${retried.d1Queries - 7} D1 queries, budgeted 13`);
  });
});

test("attendance notices: new notices go first, a notice that keeps failing backs off, and one notice fits a slice's budget", async () => {
  const { db, env } = await installation(); testMembers(db);
  // The two newest meetings' notices keep failing; an older meeting has never had one.
  const failing = [endedMeeting(db, 2, "Failing Meeting 1"), endedMeeting(db, 3, "Failing Meeting 2")];
  const fresh = endedMeeting(db, 6, "Test Meeting New");
  for (const meetingId of failing) notice(db, meetingId, "failed", 2, 10);
  await withMessages(async (posts) => {
    quietJobs(db); const now = Date.now();
    const first = await runSchedulerSlice(env, { "attendance.discord-notices": now }, now, sliceHooks());
    assert.match(posts[0]!.content, /Test Meeting New/, "the notice never attempted is sent first");
    assert.equal(noticeRow(db, fresh)?.status, "delivered");
    assert.equal(Boolean(first.more), false, "retries left over wait for the job's next regular run");
    assert.ok(first.d1Queries + first.externalRequests <= scheduledSliceLimits.total, JSON.stringify(first));
    // A notice with only failing work: tried, counted, and no immediate re-run.
    db.sqlite.prepare("UPDATE discord_attendance_notifications SET updated_at = ? WHERE status = 'failed'").run(minutesAgo(10));
    quietJobs(db); const later = Date.now();
    const second = await runSchedulerSlice(env, { "attendance.discord-notices": later }, later, sliceHooks());
    assert.equal(Boolean(second.more), false);
    assert.ok(second.nextWake >= later + 240_000);
    assert.ok(failing.some((meetingId) => noticeRow(db, meetingId)!.attempts === 3), "the failed attempt is counted");
    // Sixteen attempts is the cap; Send Discord absence notice on the meeting still sends it.
    db.sqlite.prepare("UPDATE discord_attendance_notifications SET attempts = 16, updated_at = ? WHERE status = 'failed'").run(minutesAgo(3 * 24 * 60));
    const before = posts.length; quietJobs(db); const last = Date.now();
    await runSchedulerSlice(env, { "attendance.discord-notices": last }, last, sliceHooks());
    assert.equal(posts.length, before, "a notice past its last attempt is left alone");
  });
});

/** A backlog in every delivery job: calendar events, absence notices and anomaly reports all waiting. */
function backlog(db: TestD1Database) {
  testMembers(db); enableAnomalyReports(db);
  for (let index = 0; index < 8; index += 1) meetingWithPendingEvent(db, 2 + index);
  for (let index = 0; index < 6; index += 1) lateArrival(db, endedMeeting(db, 3 + index, `Test Meeting Past ${index + 1}`));
}

test("worst case: with every job due and a backlog in each, a Durable Object slice stays within 40 subrequests in all", async () => {
  const { db, env } = await installation(); backlog(db);
  await withMessages(async () => {
    const counted = countingDatabase(db); let fetches = 0; const original = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => { fetches += 1; return original(...args); }) as typeof fetch;
    try {
      let now = Date.now(); const slices: { job: string | undefined; d1: number; external: number }[] = [];
      for (let index = 0; index < 60; index += 1) {
        const before = { d1: counted.queries.length, external: fetches };
        const report = await runSchedulerSlice({ ...env, DB: counted } as Env, {}, now, sliceHooks());
        slices.push({ job: report.ran, d1: counted.queries.length - before.d1, external: fetches - before.external });
        assert.equal(report.d1Queries, counted.queries.length - before.d1, "the budget counts every D1 query the slice makes");
        assert.equal(report.externalRequests, fetches - before.external, "and every provider request");
        if (!report.attempted.length) break;
        now = report.more ? report.nextWake : now + 1_000;
      }
      const worst = Math.max(...slices.map((slice) => slice.d1 + slice.external));
      assert.ok(worst <= scheduledSliceLimits.total, `the worst slice used ${worst} of ${scheduledSliceLimits.total}: ${JSON.stringify(slices)}`);
      assert.ok(worst >= 20, `the backlog makes some slice busy: ${worst}`);
      assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM discord_attendance_notifications WHERE status = 'delivered'").get() as { n: number }).n, 6, "and the work still gets done");
    } finally { globalThis.fetch = original; }
  });
});

test("worst case: with every job due and a backlog in each, a cron pass stays within 46 subrequests in all and records its outcomes", async () => {
  const { db, env } = await installation(); backlog(db);
  await withMessages(async (_posts, requests) => {
    const counted = countingDatabase(db); const passes: { d1: number; external: number }[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      // Every job is due at every tick.
      db.sqlite.exec("UPDATE platform_scheduler_state SET jobs_json = '{}'");
      const before = { d1: counted.queries.length, external: requests.length };
      await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: (tick + 1) * 300_000 } as never, { ...env, DB: counted } as Env);
      passes.push({ d1: counted.queries.length - before.d1, external: requests.length - before.external });
      assert.match(counted.queries.at(-1)!, /^INSERT INTO platform_scheduler_state/, "the pass's last query is its closing state write");
      const outcomes = Object.values(JSON.parse((db.sqlite.prepare("SELECT jobs_json AS j FROM platform_scheduler_state").get() as { j: string }).j) as Record<string, { outcome: string }>).map((state) => state.outcome);
      assert.ok(outcomes.length > 0 && !outcomes.includes("running"), `no job is left marked running: ${outcomes.join(",")}`);
    }
    const worst = Math.max(...passes.map((pass) => pass.d1 + pass.external));
    assert.ok(worst <= scheduledPassLimits.total, `the worst pass used ${worst} of ${scheduledPassLimits.total}: ${JSON.stringify(passes)}`);
    assert.ok(worst >= 30, `the backlog makes a pass busy: ${JSON.stringify(passes)}`);
  });
});

test("cron mode with the Durable Object bound: the cron tells the object to stand down before its pass, and the object's alarm runs no jobs", async () => {
  const { db, env } = await installation(); quietJobs(db); due(db, "attendance.discord-calendar");
  meetingWithPendingEvent(db, 3);
  const order: string[] = [];
  const cronMode = { ...env, PLATFORM_SCHEDULER_MODE: "cron", PLATFORM_SCHEDULER: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => { order.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ alarm: null, standby: true }); } }) } } as unknown as Env;
  await withDiscord(async (requests) => {
    const original = globalThis.fetch; globalThis.fetch = ((...args: Parameters<typeof fetch>) => { order.push("discord"); return original(...args); }) as typeof fetch;
    try { await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: Date.now() } as never, cronMode); } finally { globalThis.fetch = original; }
    assert.equal(order[0], "POST /standdown", "the object stands down before the pass runs a job");
    assert.ok(order.includes("discord"), "and the cron pass does the work");
    assert.equal(order.filter((line) => line.startsWith("POST /")).length, 1, "one request to the object per tick");
    // An alarm armed before the switch to cron mode fires: it must not run the jobs the cron now runs.
    requests.length = 0; due(db, "attendance.discord-calendar"); meetingWithPendingEvent(db, 4);
    const stored = new Map<string, unknown>(); let alarm: number | null = Date.now();
    const storage = { get: async <T>(key: string) => stored.get(key) as T | undefined, put: async (key: string, value: unknown) => { stored.set(key, value); }, delete: async (key: string) => stored.delete(key), getAlarm: async () => alarm, setAlarm: async (time: number) => { alarm = time; }, deleteAlarm: async () => { alarm = null; } };
    const reads = db.reads;
    await new PlatformScheduler({ storage }, cronMode).alarm();
    assert.equal(requests.length, 0, "the object's alarm sends nothing to Discord");
    assert.equal(db.reads, reads, "and reads nothing from D1");
    assert.equal(alarm, null, "and does not re-arm itself");
    // The same object in durable mode does run the slice.
    alarm = Date.now(); await new PlatformScheduler({ storage }, { ...cronMode, PLATFORM_SCHEDULER_MODE: undefined } as unknown as Env).alarm();
    assert.equal(requests.filter((line) => line.startsWith("POST")).length, 1); assert.notEqual(alarm, null);
  });
});

test("two deliveries of one cron tick: the second finds the jobs claimed and runs none, so a notice is posted once", async () => {
  const { db, env } = await installation(); testMembers(db); quietJobs(db); due(db, "attendance.discord-notices");
  endedMeeting(db, 5, "Test Meeting Once");
  await withMessages(async (posts) => {
    const tick = { cron: "*/5 * * * *", scheduledTime: Date.now() } as never;
    await Promise.all([worker.scheduled(tick, env), worker.scheduled(tick, env)]);
    assert.equal(posts.filter((post) => post.content.includes("Test Meeting Once")).length, 1);
    assert.equal(storedJob(db, "attendance.discord-notices").outcome, "ok");
  });
});

test("a runner's closing write keeps what another writer recorded for a job it did not run", async () => {
  const { db, env } = await installation(); quietJobs(db);
  meetingWithPendingEvent(db, 3);
  const other = { next: 4_102_444_800_000, last: 1_700_000_000_000, outcome: "failed" };
  // While this slice's job is talking to Discord, another runner records housekeeping's outcome.
  let written = false;
  const record = () => { if (written) return; written = true; db.sqlite.prepare("UPDATE platform_scheduler_state SET jobs_json = json_set(jobs_json, '$.\"core.housekeeping\"', json(?))").run(JSON.stringify(other)); };
  await withMessages(async () => {
    const now = Date.now();
    const report = await runSchedulerSlice(env, { "attendance.discord-calendar": now }, now, sliceHooks());
    assert.deepEqual(report.attempted, ["attendance.discord-calendar"]); assert.equal(written, true);
  }, record);
  assert.deepEqual(storedJob(db, "core.housekeeping"), other, "the other job's state is not put back to what this slice read");
  assert.equal(storedJob(db, "attendance.discord-calendar").outcome, "ok");
});

test("when the scheduler state cannot be read, a slice runs every due job once and sleeps five minutes instead of looping housekeeping every second", async () => {
  const { db, env } = await installation(); meetingWithPendingEvent(db, 3);
  const counted = countingDatabase(db);
  counted.fail = (statements) => { if (statements.some((sql) => sql.includes("FROM platform_scheduler_state"))) throw new Error("D1_ERROR: synthetic read failure"); };
  await withDiscord(async (requests) => {
    const now = Date.now(); const slices: Awaited<ReturnType<typeof runSchedulerSlice>>[] = [];
    for (let index = 0; index < 3; index += 1) slices.push(await runSchedulerSlice({ ...env, DB: counted } as Env, {}, now + index * SLICE_IDLE_MAX_MS, sliceHooks()));
    const first = slices[0]!;
    assert.equal(Boolean(first.more), false, "no continuation is asked for: without state it could never be recorded as served");
    assert.equal(first.nextWake, now + SLICE_IDLE_MAX_MS, "the next slice is five minutes later");
    assert.equal(first.stateless, true);
    assert.ok(first.attempted.includes("core.housekeeping") && first.attempted.includes("attendance.discord-calendar"), `every due job runs, not only the first: ${first.attempted.join(",")}`);
    assert.equal(requests.filter((line) => line.startsWith("POST") && line.endsWith("/scheduled-events")).length, 1, "the waiting calendar event went out");
    assert.ok(slices.every((slice) => slice.d1Queries + slice.externalRequests <= scheduledPassLimits.total), "each within a pass's budget");
  });
});
