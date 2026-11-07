// The Free-plan scheduler against real SQL: one slice per invocation within its budget, re-arming while work remains,
// Discord's 60-day event horizon, a Stop that pauses every delivery and expires after 24 hours, scheduler status on a
// deployment with no Durable Object, and the cron as a watchdog only. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, runSchedulerSlice, type Env } from "../apps/api/src/index.ts";
import { SCHEDULER_STOP_MS, SLICE_CONTINUE_MS, SLICE_IDLE_MAX_MS } from "../apps/api/src/platform-scheduler.ts";
import { scheduledSliceLimits } from "../apps/api/src/scheduler-budget.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { createSessionCodec } from "../apps/api/src/runtime-security.ts";
import { InstallationSeed, TestD1Database, attendanceWithOutreachDisabled } from "./fixtures/d1-database.ts";
import { sessionSecret } from "./fixtures/worker-fake-database.ts";

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
