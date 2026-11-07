// The scheduled pass's shared budget: counting, deferral of jobs it cannot cover, and the rotating job order.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { registeredCoreSchedulerJobs, registeredModuleSchedulerJobs, type Env } from "../apps/api/src/index.ts";
import { SchedulerBudget, passSlot, rotateJobs, scheduledPassLimits } from "../apps/api/src/scheduler-budget.ts";
import { encryptIntegration } from "../apps/api/src/integration-crypto.ts";
import { FakeDatabase, sessionSecret } from "./fixtures/worker-fake-database.ts";

const jobIds = [...registeredCoreSchedulerJobs, ...registeredModuleSchedulerJobs].map((job) => job.id);
type Controller = { cron: string; scheduledTime?: number };

test("the pass budget counts every query and batch once and stops below the Free plan's limits", async () => {
  const budget = new SchedulerBudget({ d1: 5, external: 2 });
  const database = new FakeDatabase(); const db = budget.database(database as never);
  await db.prepare("SELECT 1").first(); await db.prepare("SELECT 2").bind(1).all(); await db.prepare("UPDATE x SET y = 1").run();
  // The fake records a batch that writes in `batches` (an all-read batch is recorded as separate reads).
  await db.batch([db.prepare("SELECT 3"), db.prepare("UPDATE z SET a = 4")]);
  assert.equal(budget.d1, 4, "a batch is one query");
  assert.equal(database.batches.at(-1)?.length, 2, "the batch reaches D1 with the original statements");
  assert.equal(budget.allows({ d1: 1 }), true); assert.equal(budget.allows({ d1: 2 }), false);
  budget.chargeExternal(2);
  assert.equal(budget.allows({ external: 1 }), false); assert.equal(budget.allows({}), true);
  budget.defer("example.job");
  assert.deepEqual(budget.snapshot(), { d1Queries: 4, externalRequests: 2, deferred: ["example.job"] });
  assert.ok(scheduledPassLimits.d1 < 50 && scheduledPassLimits.external < 50);
});

test("each slot starts the job order one job later and every job leads one slot in turn", () => {
  const jobs = ["a", "b", "c", "d"];
  assert.deepEqual(rotateJobs(jobs, 0), ["a", "b", "c", "d"]);
  assert.deepEqual(rotateJobs(jobs, 1), ["b", "c", "d", "a"]);
  assert.deepEqual(rotateJobs(jobs, 6), ["c", "d", "a", "b"]);
  assert.deepEqual(rotateJobs(jobs, -1), ["d", "a", "b", "c"]);
  assert.deepEqual(rotateJobs([], 3), []);
  assert.deepEqual(new Set(Array.from({ length: jobs.length }, (_, slot) => rotateJobs(jobs, slot)[0])), new Set(jobs));
  assert.equal(passSlot(Date.parse("2026-11-03T12:04:59Z")), passSlot(Date.parse("2026-11-03T12:00:00Z")));
  assert.equal(passSlot(Date.parse("2026-11-03T12:05:00Z")), passSlot(Date.parse("2026-11-03T12:00:00Z")) + 1);
});

async function configuredDatabase() {
  const database = new FakeDatabase();
  const discord = await encryptIntegration({ botToken: "discord-secret", guildId: "123456789012345678", channelId: "223456789012345678", publicKey: "a".repeat(64) }, sessionSecret);
  database.rows.set("FROM encrypted_integrations", { id: "discord-1", ...discord, updatedAt: "2026-08-30T00:00:00Z", verifiedAt: "2026-08-30T00:01:00Z", enabled: 1 });
  database.rows.set("discord_channel_manager_enabled AS enabled", { enabled: 0 });
  return database;
}
const environment = (database: FakeDatabase) => ({ APP_MODE: "configured", ALLOWED_ORIGIN: "https://dashboard.example.test", SESSION_KEY: sessionSecret, INTEGRATION_KEY: sessionSecret, DB: database }) as unknown as Env;
async function scheduled(env: Env, controller: Controller) {
  const originalFetch = globalThis.fetch; const originalLog = console.log; const logs: string[] = []; const outbound: string[] = [];
  globalThis.fetch = async (input) => { outbound.push(String(input)); return Response.json({ id: "message-1" }); };
  console.log = (line: unknown) => { logs.push(String(line)); };
  try { await worker.scheduled(controller as never, env); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  return { logs, outbound };
}

test("an idle pass reads maintenance, module state and each integration record once for all its jobs", async () => {
  const database = await configuredDatabase();
  const { logs } = await scheduled(environment(database), { cron: "*/5 * * * *", scheduledTime: 0 });
  const queries = [...database.calls, ...database.batches.map((batch) => batch[0]!)];
  const count = (fragment: string) => [...database.calls, ...database.batches.flat()].filter((call) => call.sql.includes(fragment)).length;
  assert.equal(count("FROM web_update_requests WHERE installation_id = 'primary' AND maintenance = 1"), 1, "once, batched with module and scheduler state, before any job");
  assert.equal(count("FROM platform_scheduler_state"), 1, "scheduler state is read once");
  assert.equal(count("FROM platform_modules m"), 1, "one read of every runnable module");
  assert.equal(count("FROM encrypted_integrations i"), 1, "Discord's record is read once and shared");
  assert.ok(queries.length < 30, `an idle pass costs ${queries.length} D1 queries`);
  assert.deepEqual(logs, [], "nothing is deferred while the pass is idle");
});

test("jobs the pass budget cannot cover are deferred and logged, and a later slot runs them first", async () => {
  const database = await configuredDatabase(); const now = Date.now();
  const google = await encryptIntegration({ clientId: "calendar-client", clientSecret: "calendar-secret", refreshToken: "calendar-refresh", calendarId: "calendar@example.test" }, sessionSecret);
  database.rows.set("google_calendar_enabled AS enabled", { ...google, enabled: 1, authorizedAt: "2026-09-05", verifiedAt: "2026-09-05" });
  database.rows.set("late_scan_minutes AS lateScanMinutes, discord_contest_window_hours", { lateScanMinutes: 30, contestWindowHours: 24 });
  database.rows.set("anomaly_late_threshold_minutes AS anomalyLateThresholdMinutes", { lateScanMinutes: 30, anomalyLateThresholdMinutes: 10, anomalyEarlyThresholdMinutes: 10, enabled: 1, channelId: "323456789012345678", enabledAt: new Date(now - 24 * 3_600_000).toISOString() });
  const past = Array.from({ length: 4 }, (_, index) => ({ id: `meeting-${index + 1}`, title: `Test Meeting ${index + 1}`, startsAt: new Date(now - (4 + index) * 3_600_000).toISOString(), endsAt: new Date(now - (3 + index) * 3_600_000).toISOString() }));
  database.rows.set("SELECT title, notes, required, attendance_weight AS attendanceWeight FROM meetings", { title: "Test Meeting", notes: null, required: 1, attendanceWeight: 1 });
  // A Google Calendar backlog large enough to use most of a pass, and anomaly reports waiting behind it.
  database.lists.set("FROM google_calendar_operations o", past.map((meeting) => ({ meetingId: meeting.id, eventId: `event-${meeting.id}`, action: "upsert", startsAt: meeting.startsAt, endsAt: meeting.endsAt, status: "pending", attempts: 0, syncedAt: "2026-09-06", generation: 1 })));
  database.lists.set("LEFT JOIN discord_anomaly_reports", past);
  database.lists.set("SELECT m.external_id AS memberId", (_sql: string, values: unknown[]) => { const meeting = past.find((item) => values.includes(item.id)) ?? past[0]!; return [{ memberId: "TEST-A", firstName: "Test Student", lastName: "A", checkedInAt: new Date(Date.parse(meeting.startsAt) + 20 * 60_000).toISOString(), checkedOutAt: meeting.endsAt }]; });
  database.lists.set("LEFT JOIN discord_attendance_notifications", []);
  const env = environment(database);
  const googleFirst = jobIds.indexOf("attendance.google-calendar");
  const passes: { deferred: string[]; d1: number; reports: number }[] = [];
  for (const slot of [googleFirst, googleFirst + 1, googleFirst + 2, googleFirst + 3, googleFirst + 4]) {
    const before = database.calls.length + database.batches.length;
    const { logs, outbound } = await scheduled(env, { cron: "*/5 * * * *", scheduledTime: slot * 300_000 });
    const deferredLog = logs.map((line) => JSON.parse(line) as { event: string; deferred: string[] }).find((entry) => entry.event === "scheduler_jobs_deferred");
    passes.push({ deferred: deferredLog?.deferred ?? [], d1: database.calls.length + database.batches.length - before, reports: outbound.filter((url) => url.endsWith("/channels/323456789012345678/messages")).length });
  }
  assert.ok(passes.every((pass) => pass.d1 <= 50), `every pass stays within 50 D1 queries: ${JSON.stringify(passes)}`);
  assert.ok(passes[0]!.deferred.length > 0, "the first pass defers the jobs it cannot cover, and says so");
  assert.ok(passes.some((pass) => pass.reports > 0), "a later slot reaches the anomaly reports the first pass deferred");
});
