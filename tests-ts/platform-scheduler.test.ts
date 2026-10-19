import test from "node:test";
import assert from "node:assert/strict";
import { schedulerClass } from "../apps/api/src/platform-scheduler.ts";
import { registeredModuleSchedulerJobs } from "../apps/api/src/index.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";

function harness(jobs: Array<{ id: string; interval: number; enabled?: () => Promise<boolean>; run: () => Promise<void> }>, authorize = async () => true, suspended = async () => false) {
  let value: { enabled: boolean; jobs: Record<string, { next: number; last: number | null; outcome: string }> } | undefined;
  let alarm: number | null = null, writes = 0;
  const storage = {
    transaction: async <T>(callback: () => Promise<T>) => callback(),
    get: async () => structuredClone(value),
    put: async (_key: string, next: unknown) => { writes += 1; value = structuredClone(next) as typeof value; },
    getAlarm: async () => alarm,
    setAlarm: async (next: number) => { alarm = next; },
    deleteAlarm: async () => { alarm = null; },
  };
  const Scheduler = schedulerClass(jobs, authorize, (env: { mode: string }) => env.mode === "durable", suspended);
  return {
    create: (mode = "durable") => new Scheduler({ storage }, { mode }),
    due: () => { for (const job of Object.values(value!.jobs)) job.next = 0; },
    snapshot: () => value!, alarm: () => alarm, writes: () => writes,
  };
}

const request = (action: "status" | "start" | "stop") => new Request(`https://fixture.invalid/${action}`, { method: action === "status" ? "GET" : "POST" });

test("durable scheduler serializes control and alarm work, isolates failures, and resumes state", async () => {
  const calls: string[] = [];
  const fixture = harness([
    { id: "fixture.failure", interval: 300_000, run: async () => { calls.push("failure"); throw new Error("private provider detail"); } },
    { id: "fixture.success", interval: 300_000, run: async () => { calls.push("success"); } },
  ]);
  const scheduler = fixture.create();
  await Promise.all([scheduler.fetch(request("start")), scheduler.fetch(request("start"))]);
  const writes = fixture.writes(); await scheduler.fetch(request("status")); await scheduler.fetch(request("start"));
  assert.equal(fixture.writes(), writes);
  fixture.due(); await Promise.all([scheduler.alarm(), scheduler.alarm(), scheduler.alarm()]);
  assert.deepEqual(calls, ["failure", "success"]); assert.equal(fixture.snapshot().jobs["fixture.failure"]!.outcome, "failed");
  assert.equal(JSON.stringify(fixture.snapshot()).includes("private provider"), false);
  const restarted = fixture.create(); assert.equal((await (await restarted.fetch(request("status"))).json() as { enabled: boolean }).enabled, true);
  await restarted.fetch(request("stop")); assert.equal(fixture.alarm(), null); fixture.due(); await restarted.alarm(); assert.equal(calls.length, 2);
});

test("disabled module jobs pause and authorization is rechecked for every control request", async () => {
  let active = true, enabled = false, calls = 0;
  const fixture = harness([{ id: "fixture.module", interval: 300_000, enabled: async () => enabled, run: async () => { calls += 1; } }], async () => active);
  const scheduler = fixture.create(); await scheduler.fetch(request("start")); fixture.due(); await scheduler.alarm();
  assert.equal(fixture.snapshot().jobs["fixture.module"]!.outcome, "paused"); assert.equal(calls, 0);
  active = false; assert.equal((await scheduler.fetch(request("stop"))).status, 403);
  active = true; enabled = true; fixture.due(); await scheduler.alarm(); assert.equal(calls, 1);
});

test("scheduler jobs are derived from the static module registry", () => {
  const declared = bundledModuleRegistry.modules.filter((module) => module.available).flatMap((module) => module.jobs.map((job) => job.id));
  assert.deepEqual(registeredModuleSchedulerJobs.map((job) => job.id), declared);
  assert.equal(new Set(declared).size, declared.length);
});

test("scheduler supports additional static module jobs without a Core job-count limit", async () => {
  const calls: number[] = [];
  const jobs = Array.from({ length: 32 }, (_, index) => ({ id: `module-${index}.work`, interval: 300_000, run: async () => { calls.push(index); } }));
  const fixture = harness(jobs), scheduler = fixture.create();
  assert.equal((await scheduler.fetch(request("start"))).status, 200); fixture.due();
  for (let index = 0; index < jobs.length; index += 1) await scheduler.alarm();
  assert.deepEqual(calls, Array.from({ length: 32 }, (_, index) => index)); assert.equal(Object.keys(fixture.snapshot().jobs).length, 32); assert.ok((fixture.alarm() ?? 0) > Date.now());
});

test("maintenance retains due jobs across restart and resumes without another start", async () => {
  let maintenance = true, calls = 0, eligibilityChecks = 0;
  const fixture = harness([{ id: "fixture.job", interval: 300_000, enabled: async () => { eligibilityChecks++; return true; }, run: async () => { calls++; } }], async () => true, async () => maintenance);
  const scheduler = fixture.create(); await scheduler.fetch(request("start")); fixture.due();
  const before = structuredClone(fixture.snapshot()), writes = fixture.writes();
  await scheduler.alarm(); await fixture.create().alarm();
  assert.equal(calls, 0); assert.equal(eligibilityChecks, 0);
  assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.writes(), writes);
  assert.ok(fixture.alarm()! > Date.now() + 25_000); assert.ok(fixture.alarm()! <= Date.now() + 30_000);
  maintenance = false; await fixture.create().alarm();
  assert.equal(calls, 1); assert.equal(fixture.snapshot().jobs["fixture.job"].outcome, "ok");
  await scheduler.alarm(); assert.equal(calls, 1);
});

test("maintenance read failure fails closed and a manual stop cancels its retry", async () => {
  let calls = 0;
  const fixture = harness([{ id: "fixture.job", interval: 300_000, run: async () => { calls++; } }], async () => true, async () => { throw new Error("database unavailable"); });
  const scheduler = fixture.create(); await scheduler.fetch(request("start")); fixture.due();
  const before = structuredClone(fixture.snapshot()); await scheduler.alarm();
  assert.equal(calls, 0); assert.deepEqual(fixture.snapshot(), before); assert.ok(fixture.alarm());
  await scheduler.fetch(request("stop")); await scheduler.alarm();
  assert.equal(fixture.alarm(), null); assert.equal(calls, 0);
});
