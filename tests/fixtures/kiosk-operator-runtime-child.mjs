// Dependency mocks belong to the isolated test process. Production has no
// sensor bypass or synthetic-reader mode.
import { mock } from "node:test";
import { once } from "node:events";
const original = await import("../../apps/kiosk/src/r503.mjs");
const identityResolver = await import("../../apps/kiosk/src/identity-resolver.mjs");
const attendanceClock = await import("../../apps/kiosk/src/attendance-clock.mjs");
mock.module(new URL("../../apps/kiosk/src/attendance-clock.mjs", import.meta.url).href, { namedExports: {
  createAttendanceClock: path => attendanceClock.createAttendanceClock(path, { synchronized: async () => false }),
} });
let present = true, slot = 0, enrollCalls = 0, holdEnrollment = false, releaseEnrollment;
let holdIdentity = false, identityCalls = 0, releaseIdentity;
const occupied = new Set([0]);
const sensor = {
  status: async () => ({ connected: true, templateCount: occupied.size }),
  occupiedSlots: async () => [...occupied],
  fingerPresent: async () => present,
  scan: async () => present ? { status: "match", slot, score: 100 } : { status: "no_finger" },
  led: async () => {},
  enroll: async (nextSlot, { onProgress, checkActive = () => {}, beforeStore = async () => {} }) => {
    enrollCalls++;
    await onProgress("enroll_wait_first");
    if (holdEnrollment) await new Promise(resolve => { releaseEnrollment = resolve; });
    await onProgress("enroll_scan_accepted"); await onProgress("enroll_wait_second");
    await beforeStore(); checkActive();
    occupied.add(nextSlot); slot = nextSlot; present = true;
    await onProgress("enroll_success"); return { slot };
  },
};
mock.module(new URL("../../apps/kiosk/src/r503.mjs", import.meta.url).href, { namedExports: { ...original, createR503: () => sensor } });
// The service constructs this adapter even with a mocked sensor.
mock.module(new URL("../../apps/kiosk/src/serial-transport.mjs", import.meta.url).href, { namedExports: { createSerialExchange: () => async () => { throw new Error("Synthetic test must not use serial transport"); } } });
mock.module(new URL("../../apps/kiosk/src/network-manager.mjs", import.meta.url).href, { namedExports: { createNetworkManager: () => ({ diagnostics: async () => ({ type: "wifi", signal: 100 }) }) } });
mock.module(new URL("../../apps/kiosk/src/identity-resolver.mjs", import.meta.url).href, { namedExports: { resolveIdentityObservation: async input => {
  identityCalls++;
  if (holdIdentity) await new Promise(resolve => { releaseIdentity = resolve; });
  return identityResolver.resolveIdentityObservation(input);
} } });
process.on("message", message => {
  if (message.present !== undefined) present = message.present;
  if (message.slot !== undefined) slot = message.slot;
  if (message.holdEnrollment !== undefined) holdEnrollment = message.holdEnrollment;
  if (message.releaseEnrollment) { releaseEnrollment?.(); releaseEnrollment = undefined; }
  if (message.holdIdentity !== undefined) holdIdentity = message.holdIdentity;
  if (message.releaseIdentity) { releaseIdentity?.(); releaseIdentity = undefined; }
  process.send({ id: message.id, enrollCalls, present, slot, identityCalls });
});
const { server } = await import("../../apps/kiosk/src/service.mjs");
if (!server.listening) await once(server, "listening");
process.send({ ready: true, port: server.address().port });
