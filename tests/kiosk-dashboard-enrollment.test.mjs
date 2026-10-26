import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardEnrollment, readEnrollmentSession } from "../apps/kiosk/src/dashboard-enrollment.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";

const config = { apiUrl: "https://example.test", kioskId: "synthetic-kiosk", pairingId: "synthetic-pair", kioskToken: "synthetic-token" };
const member = { rosterId: "synthetic-row", memberId: "synthetic-member", firstName: "Sample", lastName: "Member" };
const session = () => ({ id: "synthetic-session", pairingId: config.pairingId, expiresAt: 301000, state: "ready", member, progress: "awaiting_confirmation" });
function fixture(enroll = async () => ({ enrolled: true })) {
  let time = 1000, remote = session(), pairing = config, idle = 0, reads = 0;
  const statuses = [];
  const controller = createDashboardEnrollment({ now: () => time, loadPairing: async () => pairing,
    fetchSession: async () => { reads++; return remote; }, sendProgress: async (_, id, value) => {
      assert.equal(id, remote.id); statuses.push(value.status); remote = { ...remote, progress: value.status }; return remote;
    }, enroll, onIdle: async () => { idle++; } });
  return { controller, statuses, start: () => controller.update(remote, config), remote: value => { remote = value; }, pairing: value => { pairing = value; }, time: value => { time = value; }, reads: () => reads, idle: () => idle };
}

test("remote enrollment confirms the immutable member and revalidates before storage", async () => {
  const f = fixture(async ({ member: selected, checkActive, beforeStore, onProgress }) => {
    assert.deepEqual(selected, member); checkActive();
    for (const stage of ["enroll_wait_first", "enroll_remove", "enroll_wait_second"]) await onProgress(stage);
    await beforeStore(); checkActive(); return { enrolled: true, slot: 3 };
  });
  await f.start(); assert.deepEqual(f.statuses, []);
  assert.deepEqual(await f.controller.confirm(session().id), { enrolled: true, slot: 3 });
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.statuses, ["awaiting_confirmation", "enroll_wait_first", "enroll_remove", "enroll_wait_second", "enroll_success"]);
  assert.equal(f.controller.active(), false); assert.equal(f.controller.snapshot().busy, false);
});

test("a second confirmation cannot race the first authority read", async () => {
  let release, writes = 0;
  const f = fixture(async () => { writes++; }); await f.start();
  const controller = createDashboardEnrollment({ now: () => 1000, loadPairing: () => new Promise(resolve => { release = () => resolve(config); }), fetchSession: async () => session(), sendProgress: async (_, __, value) => ({ ...session(), progress: value.status }), enroll: async () => { writes++; } });
  await controller.update(session(), config); const first = controller.confirm(session().id);
  await assert.rejects(controller.confirm(session().id), /already in progress/); release(); await first; assert.equal(writes, 1);
});

for (const reason of ["cancelled", "expired", "pairing", "member", "offline"]) test(`remote ${reason} prevents reader storage`, async () => {
  let stored = false;
  const f = fixture(async ({ beforeStore, checkActive }) => {
    if (reason === "cancelled") f.remote({ ...session(), state: "cancelled", progress: "cancelled" });
    if (reason === "expired") f.time(301000);
    if (reason === "pairing") f.pairing({ ...config, pairingId: "new-pair" });
    if (reason === "member") f.remote({ ...session(), member: { ...member, rosterId: "other-row" } });
    if (reason === "offline") await f.controller.unavailable();
    await beforeStore(); checkActive(); stored = true;
  });
  await f.start(); await assert.rejects(f.controller.confirm(session().id)); assert.equal(stored, false); assert.equal(f.controller.active(), false);
});

test("waiting selection, malformed session and rejected reader startup never grant authority", async () => {
  const f = fixture(); f.remote({ ...session(), member: undefined, state: "waiting_member", progress: "waiting_member" }); await f.start();
  await assert.rejects(f.controller.confirm(session().id), /Choose a member/);
  for (const value of [{ ...session(), pairingId: "other" }, { ...session(), expiresAt: 301001 }, { ...session(), member: { ...member, firstName: "<bad>\n" } }]) assert.throws(() => readEnrollmentSession(value, config, 1000));
  const failed = createDashboardEnrollment({ now: () => 1000, onActive: async () => { throw new Error("busy"); } });
  await assert.rejects(failed.update(session(), config), /busy/); assert.equal(failed.active(), false);
});

test("local cancellation revokes reader authority before a slow cloud acknowledgement", async () => {
  let started, releaseReader, releaseCloud, stopped = false;
  const began = new Promise(resolve => { started = resolve; });
  const controller = createDashboardEnrollment({ now: () => 1000, loadPairing: async () => config, fetchSession: async () => session(),
    sendProgress: async (_, __, value) => {
      if (value.status === "cancelled") await new Promise(resolve => { releaseCloud = resolve; });
      return { ...session(), progress: value.status };
    }, enroll: async ({ checkActive }) => { started(); await new Promise(resolve => { releaseReader = resolve; }); checkActive(); stopped = true; } });
  await controller.update(session(), config); const pending = controller.confirm(session().id); await began;
  const cancelled = controller.cancel(session().id);
  assert.equal(controller.active(), false); assert.equal(controller.snapshot().busy, true);
  await new Promise(resolve => setImmediate(resolve)); releaseReader(); await assert.rejects(pending, /cancelled or expired/);
  assert.equal(stopped, false); releaseCloud(); await cancelled; assert.equal(controller.snapshot().busy, false);
});

test("automatic slot selection preserves occupied reader slots and mapped slots", async () => {
  const assigned = [], calls = [];
  const sensor = { occupiedSlots: async () => [0, 2], enroll: async (slot, options) => { calls.push(slot); options.checkActive(); await options.beforeStore(); } };
  const mappings = { read: async () => ({ "1": { memberId: "existing" } }), assignIfUnmapped: async (...args) => assigned.push(args) };
  const result = await enrollFingerprint({ sensor, mappings, withSensor: action => action(), autoSlot: true, ...member, finger: "unspecified" });
  assert.equal(result.slot, 3); assert.deepEqual(calls, [3]); assert.equal(assigned[0][0], 3);
  sensor.occupiedSlots = async () => Array.from({ length: 200 }, (_, i) => i);
  await assert.rejects(enrollFingerprint({ sensor, mappings, withSensor: action => action(), autoSlot: true, ...member }), /No verified free/);
  await assert.rejects(enrollFingerprint({ sensor, mappings, withSensor: action => action(), autoSlot: true, replaceExisting: true, ...member }), /cannot replace/);
  assert.deepEqual(calls, [3]); assert.equal(assigned.length, 1);
});
