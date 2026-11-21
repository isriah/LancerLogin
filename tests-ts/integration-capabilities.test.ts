// The app shell's shared capabilities read (integration-capabilities.ts, on retrying-read.ts): a failed read keeps what
// was known and reads again, so it never turns Discord features such as the Reviews indicator off.
// tests-browser/contest-bulk.spec.ts checks the Reviews indicator itself in a real browser.
import test from "node:test";
import assert from "node:assert/strict";
import { createCapabilitiesReader, disabledCapabilities, type IntegrationCapabilities } from "../apps/dashboard/src/integration-capabilities.ts";

const discordOn: IntegrationCapabilities = { google: { enabled: true, configured: true }, resend: { enabled: false, configured: false }, discord: { enabled: true, configured: true } };
const discordOff: IntegrationCapabilities = { ...discordOn, discord: { enabled: true, configured: false } };
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A reader whose requests answer from `answers` in order ("fail" rejects), with timers the test fires by hand.
function harness(answers: (IntegrationCapabilities | "fail")[], delays = [10, 20]) {
  const values: IntegrationCapabilities[] = []; const timers = new Map<number, { callback: () => void; delay: number }>(); let next = 0; let requests = 0;
  const reader = createCapabilitiesReader({
    fetch: async () => { const answer = answers[requests++]; if (answer === undefined || answer === "fail") throw new Error("Capabilities are unavailable"); return answer; },
    onValue: (value) => values.push(value), delays,
    setTimer: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (timer) => { timers.delete(timer as unknown as number); },
  });
  const fire = async () => { const [id, timer] = [...timers][0]!; timers.delete(id); timer.callback(); await settle(); return timer.delay; };
  return { reader, values, timers, fire, requests: () => requests };
}

test("a failed first read shows nothing yet and reads again until it succeeds", async () => {
  const run = harness(["fail", "fail", discordOn]);
  assert.deepEqual(await run.reader.read(), disabledCapabilities);
  assert.deepEqual(run.values, [], "a failure is not reported as an answer");
  assert.equal(await run.fire(), 10); assert.equal(await run.fire(), 20);
  assert.deepEqual(run.values, [discordOn]); assert.equal(run.requests(), 3);
  assert.equal(run.timers.size, 0, "no retry after a success");
  assert.deepEqual(await run.reader.read(), discordOn, "later readers get the successful read");
});

test("a failed read after a successful one keeps the last known capabilities", async () => {
  const run = harness([discordOn, "fail", discordOff]);
  assert.deepEqual(await run.reader.read(), discordOn);
  // Leaving Integrations reads again; that read fails, and Discord stays on for the shell and for pages that read.
  assert.deepEqual(await run.reader.load(), discordOn);
  assert.deepEqual(run.values, [discordOn]);
  assert.deepEqual(await run.reader.read(), discordOn);
  // The retry brings the real change.
  await run.fire();
  assert.deepEqual(run.values, [discordOn, discordOff]);
});

test("after the listed delays it keeps reading again at the last one while the shell is open", async () => {
  const run = harness(["fail", "fail", "fail", "fail", "fail", discordOn]);
  await run.reader.read();
  assert.deepEqual([await run.fire(), await run.fire(), await run.fire(), await run.fire()], [10, 20, 20, 20]);
  assert.equal(run.requests(), 5); assert.equal(run.timers.size, 1, "a retry is still pending");
  await run.fire();
  assert.deepEqual(run.values, [discordOn]); assert.equal(run.timers.size, 0);
  // After stop, a read starts again instead of returning the failed one.
  const stopped = harness(["fail", discordOff]);
  await stopped.reader.read(); stopped.reader.stop(); assert.equal(stopped.timers.size, 0);
  assert.deepEqual(await stopped.reader.read(), discordOff);
});

test("a newer read replaces a pending retry, and only the newest read is reported", async () => {
  let release!: (value: IntegrationCapabilities) => void; let calls = 0; const values: IntegrationCapabilities[] = []; const timers: unknown[] = [];
  const reader = createCapabilitiesReader({
    fetch: () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(discordOff),
    onValue: (value) => values.push(value), setTimer: (callback) => { timers.push(callback); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => undefined,
  });
  const slow = reader.read(); await reader.load();
  release(discordOn); assert.deepEqual(await slow, discordOn);
  assert.deepEqual(values, [discordOff], "a slower, older answer does not overwrite the newer one");
  assert.deepEqual(timers, []);
});

test("stop cancels a pending retry and any a read still in flight would schedule", async () => {
  const run = harness(["fail", "fail"]);
  await run.reader.read(); assert.equal(run.timers.size, 1);
  run.reader.stop(); assert.equal(run.timers.size, 0);
  let fail!: () => void;
  const reader = createCapabilitiesReader({ fetch: () => new Promise((_, reject) => { fail = () => reject(new Error("offline")); }), onValue: () => undefined, setTimer: () => assert.fail("no retry after stop"), clearTimer: () => undefined });
  const pending = reader.read(); reader.stop(); fail();
  assert.deepEqual(await pending, disabledCapabilities);
  // An answer that arrives after stop is not reported either.
  let answer!: (value: IntegrationCapabilities) => void; const values: IntegrationCapabilities[] = [];
  const quiet = createCapabilitiesReader({ fetch: () => new Promise((resolve) => { answer = resolve; }), onValue: (value) => values.push(value) });
  const read = quiet.read(); quiet.stop(); answer(discordOn);
  assert.deepEqual(await read, discordOn); assert.deepEqual(values, []);
});
