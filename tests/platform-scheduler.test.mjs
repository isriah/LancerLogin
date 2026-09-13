import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulerClass } from '../apps/api/src/platform-scheduler.ts';
import worker from '../apps/api/src/index.ts';

function harness(jobs, authorize = async () => true) {
  let value, alarm, writes = 0;
  const storage = { transaction: async callback => callback(), get: async () => structuredClone(value), put: async (_, v) => { writes++; value = structuredClone(v); }, getAlarm: async () => alarm ?? null, setAlarm: async n => { alarm = n; }, deleteAlarm: async () => { alarm = null; } };
  const C = schedulerClass(jobs, authorize, e => e.mode === 'durable');
  return { create: (mode = 'durable') => new C({ storage }, { mode }), due: () => { for (const j of Object.values(value.jobs)) j.next = 0; }, snapshot: () => value, alarm: () => alarm, writes: () => writes };
}
const request = action => new Request(`https://fixture.invalid/${action}`, { method: action === 'status' ? 'GET' : 'POST' });
test('durable singleton serializes concurrent start and alarm calls, isolates failure, and resumes saved work', async () => {
  const calls = [];
  const h = harness([{ id: 'failure', interval: 300000, run: async () => { calls.push('failure'); throw new Error('private-provider-value'); } }, { id: 'success', interval: 300000, run: async () => { calls.push('success'); } }]);
  const a = h.create();
  await Promise.all([a.fetch(request('start')), a.fetch(request('start'))]);
  const writes = h.writes(); await a.fetch(request('status')); await a.fetch(request('start')); assert.equal(h.writes(), writes);
  h.due();
  await Promise.all([a.alarm(), a.alarm(), a.alarm()]);
  assert.deepEqual(calls, ['failure', 'success']); assert.equal(h.snapshot().jobs.failure.outcome, 'failed');
  assert.ok(!JSON.stringify(h.snapshot()).includes('private-provider'));
  const restarted = h.create(); assert.equal((await (await restarted.fetch(request('status'))).json()).enabled, true);
  await restarted.fetch(request('stop')); assert.equal(h.alarm(), null); h.due(); await restarted.alarm(); assert.equal(calls.length, 2);
  await restarted.fetch(request('start')); await restarted.alarm(); assert.equal(calls.length, 2, 'restart does not replay missed ticks');
});
test('stop waits for the one in-flight family and cancels its successor alarm', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness([{ id: 'in-flight', interval: 300000, run: async () => { entered(); await pending; } }]);
  const a = h.create(); await a.fetch(request('start')); h.due();
  const running = a.alarm(); await ready;
  let stopped = false; const stop = a.fetch(request('stop')).then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await Promise.all([running, stop]); assert.equal(h.snapshot().enabled, false); assert.equal(h.alarm(), null);
});
test('disabled module callback pauses dispatch and permission is checked inside each request', async () => {
  let active = true, enabled = false, calls = 0;
  const h = harness([{ id: 'fixture.module', interval: 300000, enabled: async () => enabled, run: async () => { calls++; } }], async () => active);
  const a = h.create(); await a.fetch(request('start')); h.due(); await a.alarm();
  assert.equal(h.snapshot().jobs['fixture.module'].outcome, 'paused'); assert.equal(calls, 0);
  active = false; assert.equal((await a.fetch(request('stop'))).status, 403);
  enabled = true; h.due(); await a.alarm(); assert.equal(calls, 1);
});
test('durable mode suppresses all legacy cron work even with a missing binding', async () => {
  const env = { PLATFORM_SCHEDULER_MODE: 'durable', DB: { prepare() { throw new Error('Cron must not query D1'); } } };
  for (const cron of ['*/5 * * * *', '0 3 * * *', '* * * * *']) await worker.scheduled({ cron }, env);
});

 test('mode-off alarm removal is recoverable by repeated start without replay or postponement', async () => {
  let calls = 0;
  const h = harness([{ id: 'fixture', interval: 300000, run: async () => { calls++; } }]);
  await h.create().fetch(request('start')); h.due();
  const before = structuredClone(h.snapshot());
  await h.create('off').alarm(); assert.equal(h.alarm(), null); assert.deepEqual(h.snapshot(), before);
  const restored = h.create(); await restored.fetch(request('status')); assert.equal(h.alarm(), null);
  await Promise.all([restored.fetch(request('start')), restored.fetch(request('start'))]);
  assert.notEqual(h.alarm(), null); assert.deepEqual(h.snapshot(), before);
  const alarm = h.alarm(), writes = h.writes();
  await restored.fetch(request('status')); await restored.fetch(request('start'));
  assert.equal(h.alarm(), alarm); assert.equal(h.writes(), writes);
  await Promise.all([restored.alarm(), restored.alarm()]); assert.equal(calls, 1);
 });
