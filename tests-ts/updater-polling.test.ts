import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdatePolling } from '../apps/dashboard/src/update-polling.ts';
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let time = 0, shown = true, requests = 0, failure = false, value = 60_000, id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const poll = createUpdatePolling({ read: async () => { requests++; if (failure) throw Error('offline'); return value; }, cadence: value => value, now: () => time, visible: () => shown,
    later: (run, ms) => { timers.set(++id, { at: time + ms, run }); return id as any; }, cancel: timer => { timers.delete(timer as any); } });
  return { poll, requests: () => requests, fail: (v: boolean) => { failure = v; }, value: (v: number) => { value = v; }, hidden: (v: boolean) => { shown = !v; poll.visibilityChanged(); }, async tick(ms: number) { time += ms; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.run(); } await settle(); } };
}
test('three consumers share idle, active and hidden request budgets without cached callback delivery', async () => {
  const f = fixture(), seen: number[] = [];
  const off = [f.poll.subscribe(v => seen.push(v)), f.poll.subscribe(() => {}), f.poll.subscribe(() => {})];
  await f.tick(0); assert.equal(f.requests(), 1);
  await f.tick(59_999); assert.equal(f.requests(), 1);
  await f.tick(1); assert.equal(f.requests(), 2);
  f.hidden(true); await f.tick(600_000); assert.equal(f.requests(), 2);
  f.hidden(false); await f.tick(0); assert.equal(f.requests(), 3);
  f.value(5000); await f.poll.refresh(); await f.tick(5000); assert.equal(f.requests(), 5);
  off.forEach(fn => fn()); await f.tick(100_000); assert.equal(f.requests(), 5); assert.equal(seen.length, 5);
});
test('errors back off, explicit refresh bypasses delay and unconfigured responses wait five minutes', async () => {
  const f = fixture(); f.poll.subscribe(() => {}); f.fail(true);
  await f.tick(0); await f.tick(29_999); assert.equal(f.requests(), 1);
  await f.tick(1); await f.tick(59_999); assert.equal(f.requests(), 2);
  await f.tick(1); assert.equal(f.requests(), 3);
  f.fail(false); f.value(300_000); await f.poll.refresh(); assert.equal(f.requests(), 4);
  await f.tick(299_999); assert.equal(f.requests(), 4); await f.tick(1); assert.equal(f.requests(), 5);
});
test('explicit refresh coalesces and late pre-action reads cannot deliver stale admission state', async () => {
  let resolve!: (value: string) => void, reads = 0; const seen: string[] = [];
  const poll = createUpdatePolling({ read: () => { reads++; return new Promise<string>(done => { resolve = done; }); }, cadence: () => 60_000, visible: () => false });
  poll.subscribe(value => seen.push(value)); const first = poll.refresh(); await settle();
  const same = poll.refresh(); assert.equal(first, same);
  const action = poll.action(async () => 'accepted-new-job'); resolve('old-available');
  await action; assert.deepEqual(seen, ['accepted-new-job']); assert.equal(reads, 1);
  const manual = poll.refresh(); await settle(); resolve('completed-job'); await manual;
  assert.deepEqual(seen, ['accepted-new-job', 'completed-job']);
});
