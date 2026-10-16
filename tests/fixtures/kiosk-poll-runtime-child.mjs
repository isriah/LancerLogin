// Hardware doubles are confined to this child. The production service, timers,
// controllers, queue and encrypted cloud protocol run unchanged.
import { mock } from "node:test";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
const original = await import("../../apps/kiosk/src/r503.mjs");
const installation = await import("../../apps/kiosk/src/unpairing-store.mjs");
let activities;
mock.module(new URL("../../apps/kiosk/src/unpairing-store.mjs", import.meta.url).href, { namedExports: {
  ...installation,
  createInstallationActivities: () => { activities = installation.createInstallationActivities(); return activities; },
} });
const flashPath = join(dirname(process.env.LANCERLOGIN_CONFIG), "synthetic-reader.json");
const flash = new Map(Object.entries(await readFile(flashPath, "utf8").then(JSON.parse).catch(() => ({}))).map(([slot, value]) => [Number(slot), Buffer.from(value, "base64")]));
const persist = () => writeFile(flashPath, JSON.stringify(Object.fromEntries([...flash].map(([slot, bytes]) => [slot, bytes.toString("base64")]))), { mode: 0o600 });
let present = false, slot = 0, imports = 0, enrollments = 0;
const sensor = {
  status: async () => ({ connected: true, templateCount: flash.size }),
  occupiedSlots: async () => [...flash.keys()], fingerPresent: async () => present,
  scan: async () => !present ? { status: "no_finger" } : flash.has(slot) ? { status: "match", slot, score: 100 } : { status: "not_found" }, led: async () => {},
  enroll: async (nextSlot, { onProgress }) => {
    enrollments++; await onProgress("enroll_wait_first"); await onProgress("enroll_scan_accepted"); await onProgress("enroll_wait_second");
    flash.set(nextSlot, Buffer.alloc(1536, 17 + nextSlot)); await persist(); slot = nextSlot; present = true;
    await onProgress("enroll_success"); return { slot };
  },
};
mock.module(new URL("../../apps/kiosk/src/r503.mjs", import.meta.url).href, { namedExports: { ...original, createR503: () => sensor } });
mock.module(new URL("../../apps/kiosk/src/serial-transport.mjs", import.meta.url).href, { namedExports: { createSerialExchange: () => async () => { throw new Error("Synthetic test cannot use serial hardware"); } } });
mock.module(new URL("../../apps/kiosk/src/network-manager.mjs", import.meta.url).href, { namedExports: { createNetworkManager: () => ({ diagnostics: async () => ({ type: "wifi", signal: 100 }) }) } });
mock.module(new URL("../../apps/kiosk/src/r503-template-transfer.mjs", import.meta.url).href, { namedExports: { r503TemplateBytes: 1536, createR503TemplateTransfer: () => ({
  exportTemplate: async slot => { if (!flash.has(slot)) throw new Error("Synthetic slot is empty"); return Uint8Array.from(flash.get(slot)); },
  importTemplate: async (slot, bytes) => { if (flash.has(slot) || bytes.length !== 1536) throw new Error("Synthetic import must preserve occupied slots"); flash.set(slot, Buffer.from(bytes)); await persist(); imports++; return { slot, verified: true }; },
}) } });
process.on("message", async message => {
  // This fixture's restart is deliberate. Wait for actual installation work,
  // including post-ack reset persistence, rather than killing a Windows marker
  // lock owner. Linux abrupt-death recovery has its separate flock tests.
  if (message.quiesce) {
    try { activities.pause(); await activities.drain(); }
    catch { process.send({ id: message.id, quiesced: false }); return; }
  }
  if (message.present !== undefined) present = message.present;
  if (message.slot !== undefined) slot = message.slot;
  if (message.forgetSlot !== undefined) { flash.delete(message.forgetSlot); await persist(); }
  process.send({ id: message.id, imports, enrollments, occupied: [...flash.keys()], ...(message.quiesce ? { quiesced: true } : {}) });
});
const { server } = await import("../../apps/kiosk/src/service.mjs");
if (!server.listening) await once(server, "listening");
process.send({ ready: true, port: server.address().port });
