// The slice scheduler's Durable Object (alarm re-arming, pokes, watchdog) and its pure due-job rules.
import test from "node:test";
import assert from "node:assert/strict";
import { SLICE_CONTINUE_MS, SLICE_DAILY_CONTINUATIONS, SLICE_IDLE_MAX_MS, SLICE_RETRY_MS, SLICE_SLOW_CONTINUE_MS, dueJobs, jobStates, nextWake, schedulerClass, schedulerRequest, type Pokes, type SchedulerJob, type SliceResult } from "../apps/api/src/platform-scheduler.ts";
import { registeredModuleSchedulerJobs } from "../apps/api/src/index.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";

type Job = SchedulerJob<unknown>;
const job = (id: string, extra: Partial<Job> = {}): Job => ({ id, interval: 300_000, run: async () => undefined, ...extra });

function harness(jobs: Job[], runSlice: (pokes: Pokes) => Promise<SliceResult>, clock = { now: 1_000_000 }) {
  const stored = new Map<string, unknown>(); let alarm: number | null = null, puts = 0, alarmWrites = 0;
  const storage = {
    get: async <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { puts += 1; stored.set(key, structuredClone(value)); },
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => { alarmWrites += 1; alarm = time; },
    deleteAlarm: async () => { alarm = null; },
  };
  const Scheduler = schedulerClass(jobs, (_env, pokes) => runSlice(pokes), () => clock.now);
  return { create: () => new Scheduler({ storage }, {}), alarm: () => alarm, setAlarm: (value: number | null) => { alarm = value; }, stored, puts: () => puts, alarmWrites: () => alarmWrites, clock };
}

test("an alarm runs one slice and re-arms about a second later while the job reports more work", async () => {
  const slices: Pokes[] = []; let remaining = 3;
  const fixture = harness([job("fixture.queue")], async (pokes) => {
    slices.push(pokes); remaining -= 1;
    return remaining > 0 ? { ran: "fixture.queue", more: true, nextWake: fixture.clock.now + SLICE_CONTINUE_MS } : { ran: "fixture.queue", nextWake: fixture.clock.now + 300_000 };
  });
  const scheduler = fixture.create();
  await scheduler.alarm();
  assert.equal(slices.length, 1, "one slice per alarm invocation");
  assert.equal(fixture.alarm(), fixture.clock.now + SLICE_CONTINUE_MS, "more work re-arms immediately");
  fixture.clock.now += SLICE_CONTINUE_MS; await scheduler.alarm();
  fixture.clock.now += SLICE_CONTINUE_MS; await scheduler.alarm();
  assert.equal(slices.length, 3);
  assert.equal(fixture.alarm(), fixture.clock.now + 300_000, "a drained queue sleeps until the next job falls due");
});

test("a write's poke arms the alarm within a second, is handed to the slice, and is cleared once that job ran", async () => {
  let seen: Pokes = {};
  const fixture = harness([job("fixture.calendar"), job("fixture.notices")], async (pokes) => { seen = { ...pokes }; return { ran: "fixture.calendar", nextWake: fixture.clock.now + 300_000 }; });
  const scheduler = fixture.create();
  fixture.setAlarm(fixture.clock.now + 240_000);
  const poked = await scheduler.fetch(schedulerRequest("poke", { jobs: ["fixture.calendar", "unknown.job"] }));
  assert.equal(poked.status, 200);
  assert.equal(fixture.alarm(), fixture.clock.now + SLICE_CONTINUE_MS, "an idle alarm is brought forward");
  assert.deepEqual(fixture.stored.get("pokes"), { "fixture.calendar": fixture.clock.now }, "only registered jobs are recorded");
  // A second poke never pushes a sooner alarm later.
  fixture.clock.now += 200; await scheduler.fetch(schedulerRequest("poke", { jobs: ["fixture.notices"] }));
  assert.equal(fixture.alarm(), fixture.clock.now - 200 + SLICE_CONTINUE_MS);
  fixture.clock.now += 1_000; await scheduler.alarm();
  assert.deepEqual(Object.keys(seen).sort(), ["fixture.calendar", "fixture.notices"]);
  assert.deepEqual(Object.keys(fixture.stored.get("pokes") as object), ["fixture.notices"], "the job that ran is cleared, the other stays due");
});

test("the watchdog only re-arms a missing alarm and never runs a slice", async () => {
  let slices = 0;
  const fixture = harness([job("fixture.job")], async () => { slices += 1; return { nextWake: fixture.clock.now }; });
  const scheduler = fixture.create();
  const first = await (await scheduler.fetch(schedulerRequest("watchdog"))).json() as { alarm: number; rearmed: boolean };
  assert.deepEqual(first, { alarm: fixture.clock.now, rearmed: true });
  fixture.setAlarm(fixture.clock.now + 120_000);
  const second = await (await scheduler.fetch(schedulerRequest("watchdog"))).json() as { alarm: number; rearmed: boolean };
  assert.deepEqual(second, { alarm: fixture.clock.now + 120_000, rearmed: false });
  assert.equal(slices, 0);
  assert.deepEqual(await (await scheduler.fetch(schedulerRequest("status"))).json(), { alarm: fixture.clock.now + 120_000 });
  assert.equal((await scheduler.fetch(new Request("https://scheduler.internal/start", { method: "POST" }))).status, 404, "the old start/stop paths are gone");
});

test("a slice that throws is retried in 30 seconds instead of looping, and serial control waits for it", async () => {
  const order: string[] = [];
  const fixture = harness([job("fixture.job")], async () => { order.push("slice"); await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("private provider detail"); });
  const scheduler = fixture.create();
  await Promise.all([scheduler.alarm(), scheduler.fetch(schedulerRequest("poke", { jobs: ["fixture.job"] })).then(() => order.push("poke"))]);
  assert.deepEqual(order, ["slice", "poke"]);
  assert.equal(fixture.alarm(), fixture.clock.now + SLICE_CONTINUE_MS, "the later poke still brings the retry forward");
  fixture.setAlarm(null); await scheduler.alarm();
  assert.equal(fixture.alarm(), fixture.clock.now + SLICE_RETRY_MS);
});

test("continuations past the daily cap slow to one a minute so a stuck job cannot use up the Free plan's DO requests", async () => {
  const fixture = harness([job("fixture.stuck")], async () => ({ ran: "fixture.stuck", more: true, nextWake: fixture.clock.now + SLICE_CONTINUE_MS }));
  const day = new Date(fixture.clock.now).toISOString().slice(0, 10);
  fixture.stored.set("continuations", { day, count: SLICE_DAILY_CONTINUATIONS - 1 });
  const scheduler = fixture.create();
  await scheduler.alarm(); assert.equal(fixture.alarm(), fixture.clock.now + SLICE_CONTINUE_MS);
  await scheduler.alarm(); assert.equal(fixture.alarm(), fixture.clock.now + SLICE_SLOW_CONTINUE_MS);
  fixture.clock.now += 86_400_000; await scheduler.alarm();
  assert.equal(fixture.alarm(), fixture.clock.now + SLICE_CONTINUE_MS, "the cap resets each UTC day");
});

test("due jobs: earliest first, registry order on ties, pokes make a job due, and a Stop leaves only internal jobs", () => {
  const jobs = [job("a"), job("b", { internal: true }), job("c")];
  const now = 10_000_000;
  const states = jobStates(jobs, { a: { next: now + 60_000, last: now - 240_000, outcome: "ok" }, b: { next: now - 5, last: null, outcome: "ok" }, c: { next: now - 10, last: null, outcome: "failed" }, removed: { next: 0, last: null, outcome: "ok" } }, now);
  assert.deepEqual(Object.keys(states), ["a", "b", "c"], "state for unregistered jobs is dropped");
  assert.deepEqual(dueJobs(jobs, states, now).map((item) => item.id), ["c", "b"]);
  assert.deepEqual(dueJobs(jobs, states, now, { pokes: { a: now - 1 } }).map((item) => item.id), ["c", "b", "a"], "a poked job is due now, after work already overdue");
  assert.deepEqual(dueJobs(jobs, states, now, { slack: 60_000 }).map((item) => item.id), ["c", "b", "a"]);
  assert.deepEqual(dueJobs(jobs, states, now, { internalOnly: true }).map((item) => item.id), ["b"]);
  // An invalid or missing state is due now.
  assert.deepEqual(jobStates(jobs, { a: { next: "soon" } }, now).a, { next: now, last: null, outcome: "waiting" });
  // A poke older than the job's last attempt was already served.
  assert.deepEqual(dueJobs(jobs, states, now, { pokes: { a: now - 300_000 } }).map((item) => item.id), ["c", "b"]);
});

test("next wake: the earliest due job, never later than the idle cap, and the Stop's end for delivery jobs", () => {
  const jobs = [job("a"), job("b", { internal: true })];
  const now = 50_000_000;
  const states = jobStates(jobs, { a: { next: now + 100_000, last: now, outcome: "ok" }, b: { next: now + 200_000, last: now, outcome: "ok" } }, now);
  assert.equal(nextWake(jobs, states, now), now + 100_000);
  assert.equal(nextWake(jobs, jobStates(jobs, { a: { next: now + 3_600_000, last: now, outcome: "ok" }, b: { next: now + 3_600_000, last: now, outcome: "ok" } }, now), now), now + SLICE_IDLE_MAX_MS);
  // While stopped, delivery jobs wait for the Stop to expire; internal housekeeping keeps its own time.
  assert.equal(nextWake(jobs, states, now, { pausedUntil: now + 7_200_000 }), now + 200_000);
  assert.equal(nextWake([job("a")], states, now, { pausedUntil: now + 7_200_000 }), now + SLICE_IDLE_MAX_MS);
  assert.equal(nextWake(jobs, states, now, { pokes: { a: now } }), now);
});

test("scheduler jobs are derived from the static module registry", () => {
  const declared = bundledModuleRegistry.modules.filter((module) => module.available).flatMap((module) => module.jobs.map((item) => item.id));
  assert.deepEqual(registeredModuleSchedulerJobs.map((item) => item.id), declared);
  assert.equal(new Set(declared).size, declared.length);
});

test("the registry rejects duplicate jobs and intervals under five minutes", () => {
  assert.throws(() => schedulerClass([job("a"), job("a")], async () => ({ nextWake: 0 })), /Invalid scheduler registry/);
  assert.throws(() => schedulerClass([job("a", { interval: 60_000 })], async () => ({ nextWake: 0 })), /Invalid scheduler registry/);
  assert.throws(() => schedulerClass([], async () => ({ nextWake: 0 })), /Invalid scheduler registry/);
});
