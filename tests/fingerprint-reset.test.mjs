import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { createFingerprintReset } from "../apps/kiosk/src/fingerprint-reset.mjs";
import { createFingerprintResetStore } from "../apps/kiosk/src/fingerprint-reset-store.mjs";
import { createFingerprintResetClient } from "../apps/kiosk/src/fingerprint-reset-client.mjs";
import { freshFingerprintSource } from "../apps/kiosk/src/fingerprint-source.mjs";
import { enrollFingerprint } from "../apps/kiosk/src/fingerprint-enrollment.mjs";
import { createFingerprintSync } from "../apps/kiosk/src/fingerprint-sync.mjs";
import { createFingerprintIdentityStore } from "../apps/kiosk/src/fingerprint-identity-store.mjs";

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-synthetic-reset-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const config = { kioskId: "synthetic-kiosk", pairingId: "synthetic-pair" };
  const mappings = createMappingStore(join(directory, "mappings.json")), models = new Map();
  let commands = [], loseComplete = false, offline = false, stops = 0;
  const client = {
    commands: async () => { if (offline) throw new Error("Synthetic offline"); return { commands }; },
    complete: async id => { if (loseComplete) { loseComplete = false; throw new Error("Synthetic lost acknowledgement"); } commands = commands.filter(command => command.id !== id); return { acknowledged: true }; },
  };
  let sensorTail = Promise.resolve();
  const withSensor = operation => { const running = sensorTail.then(operation); sensorTail = running.then(() => undefined, () => undefined); return running; };
  const factory = legacyDirectory => createFingerprintReset({ directory, legacyDirectory, config, client, mappings, withSensor, stopTransfers: async () => { stops++; } });
  return { directory, config, mappings, models, factory, withSensor, stops: () => stops,
    reset: (id = "synthetic-reset-command") => { commands = [{ id, kind: "reset_fingerprint_mappings", createdAt: "2026-01-01" }]; },
    malformed: value => { commands = value; }, offline: value => { offline = value; }, loseComplete: () => { loseComplete = true; },
  };
}

test("reset-only idle polling never reads templates or promotes historical mapped identities", async context => {
  const current = await fixture(context);
  await current.mappings.replace({ 1: { memberId: "SYN-001", finger: "legacy" } });
  assert.equal((await current.factory().tick()).status, "idle");
  assert.equal((await current.mappings.read())[1].rosterId, undefined);
  assert.equal(current.mappings.applyReviewed, undefined);
  const controller = current.factory(); assert.equal(controller.uploadProof, undefined);
  current.malformed([{ id: "retired-review", kind: "review_fingerprint_mappings" }]);
  assert.equal((await controller.tick()).blocked, true);
  assert.equal((await current.mappings.read())[1].memberId, "SYN-001"); assert.equal(current.stops(), 0);
});

test("mappings-only reset preserves reader bytes and unrelated files; lost ack never clears a subsequent enrollment", async context => {
  const current = await fixture(context); current.models.set(1, new Uint8Array(1536).fill(38)); current.models.set(7, new Uint8Array(1536).fill(39));
  await current.mappings.replace({ 1: { memberId: "SYN-001", finger: "index" } });
  for (const file of ["pairing.json", "attendance-queue.json", "credential-mappings.json"]) await writeFile(join(current.directory, file), "synthetic-preserved-state");
  current.reset(); current.loseComplete(); const first = await current.factory().tick(); assert.equal(first.blocked, true); assert.equal(first.resetEpoch, "synthetic-reset-command");
  assert.deepEqual(await current.mappings.read(), {}); assert.equal(current.stops(), 1);
  await enrollFingerprint({ sensor: { enroll: async slot => { current.models.set(slot, new Uint8Array(1536).fill(40)); } }, mappings: current.mappings,
    withSensor: current.withSensor, slot: 2, memberId: "SYN-002", rosterId: "stable-two", finger: "index", isEnrollmentAllowed: current.factory().enrollmentAllowed });
  const retry = await current.factory().tick(); assert.equal(retry.blocked, false); assert.equal(freshFingerprintSource((await current.mappings.read())[2]), true);
  assert.deepEqual([...current.models.keys()], [1, 7, 2]);
  for (const file of ["pairing.json", "attendance-queue.json", "credential-mappings.json"]) assert.equal(await readFile(join(current.directory, file), "utf8"), "synthetic-preserved-state");
});

test("an interrupted mapping-clear completion blocks enrollment until exact durable reset recovery", async context => {
  const current = await fixture(context); current.models.set(1, new Uint8Array(1536).fill(42)); await current.mappings.replace({ 1: { memberId: "SYN-001", finger: "index" } });
  const path = join(current.directory, "synthetic-kiosk-synthetic-pair", "reset.json");
  const original = current.mappings.replace; let interrupt = true;
  context.mock.method(current.mappings, "replace", async value => {
    const result = await original(value);
    if (interrupt) { interrupt = false; await writeFile(`${path}.lock`, "synthetic-completion-write-interruption", { mode: 0o600 }); }
    return result;
  });
  current.reset(); const controller = current.factory(); assert.equal((await controller.tick()).blocked, true); assert.deepEqual(await current.mappings.read(), {});
  await rm(`${path}.lock`); assert.equal(await controller.enrollmentAllowed(), false);
  let writes = 0;
  await assert.rejects(enrollFingerprint({ sensor: { enroll: async () => { writes++; } }, mappings: current.mappings, withSensor: current.withSensor,
    slot: 2, memberId: "SYN-002", finger: "index", isEnrollmentAllowed: controller.enrollmentAllowed }), /reset recovery/);
  assert.equal(writes, 0); assert.equal((await current.factory().tick()).status, "reset"); assert.equal(await controller.enrollmentAllowed(), true);
  assert.deepEqual([...current.models.keys()], [1]);
});

test("an offline reconnect with durable pending reset blocks mutations without clearing other state", async context => {
  const current = await fixture(context), path = join(current.directory, "synthetic-kiosk-synthetic-pair", "reset.json");
  const store = createFingerprintResetStore(path, current.config); await store.beginReset("pending-reset");
  current.offline(true); const controller = current.factory(); assert.equal((await controller.tick()).blocked, true); assert.equal(await controller.enrollmentAllowed(), false);
  assert.equal(await store.pendingReset(), "pending-reset"); assert.equal(current.stops(), 0);
});

test("legacy association files migrate only reset recovery metadata and remain byte-for-byte inactive", async context => {
  const current = await fixture(context), legacy = join(current.directory, "historical"), pairing = "synthetic-kiosk-synthetic-pair";
  await mkdir(join(legacy, pairing), { recursive: true, mode: 0o700 });
  const path = join(legacy, pairing, "associations.json");
  const old = JSON.stringify({ version: 1, binding: current.config, secret: "synthetic-retired-private-key", snapshot: { retired: "never activate or send" }, lastResetCommand: "completed-reset", pendingResetCommand: "pending-reset", completedCommands: ["completed-reset", "retired-review-command"] });
  await writeFile(path, old, { mode: 0o600 });
  const controller = current.factory(legacy); assert.equal(await controller.resetEpoch(), "completed-reset"); assert.equal(await controller.enrollmentAllowed(), false);
  assert.equal(await readFile(path, "utf8"), old);
  const resetState = await readFile(join(current.directory, pairing, "reset.json"), "utf8");
  assert.equal(resetState.includes("secret"), false); assert.equal(resetState.includes("snapshot"), false); assert.equal(resetState.includes("private-key"), false);
  assert.equal(resetState.includes("retired-review-command"), false);
  current.reset("pending-reset"); assert.equal((await controller.tick()).status, "reset"); assert.equal(await controller.resetEpoch(), "pending-reset");
  assert.equal(await readFile(path, "utf8"), old);
});

test("reset recovery storage enforces Linux owner-only files and refuses symlinks", { skip: process.platform === "win32" }, async context => {
  const current = await fixture(context), path = join(current.directory, "protected", "reset.json");
  const store = createFingerprintResetStore(path, current.config); await store.resetEpoch();
  await chmod(path, 0o644); await assert.rejects(store.pendingReset(), /protected local-state recovery/); await chmod(path, 0o600);
  const linked = join(current.directory, "protected", "linked.json"); await symlink(path, linked);
  await assert.rejects(createFingerprintResetStore(linked, current.config).resetEpoch(), /protected local-state recovery/);
  await chmod(join(current.directory, "protected"), 0o755); await assert.rejects(store.resetEpoch(), /protected local-state recovery/); await chmod(join(current.directory, "protected"), 0o700);
});

test("protected reset state rejects damaged, wrong-pairing, or locked legacy metadata", async context => {
  const current = await fixture(context), path = join(current.directory, "protected", "reset.json");
  const store = createFingerprintResetStore(path, current.config); assert.equal(await store.resetEpoch(), null);
  await assert.rejects(createFingerprintResetStore(path, { ...current.config, pairingId: "other-pair" }).resetEpoch(), /protected local-state recovery/);
  await writeFile(path, "{invalid", { mode: 0o600 }); await assert.rejects(store.resetEpoch(), /protected local-state recovery/);
  const legacy = join(current.directory, "legacy.json"); await writeFile(legacy, JSON.stringify({ version: 1, binding: current.config, lastResetCommand: null, pendingResetCommand: null, completedCommands: [] }), { mode: 0o600 });
  await writeFile(`${legacy}.lock`, "synthetic-active-legacy-writer", { mode: 0o600 });
  await assert.rejects(createFingerprintResetStore(join(current.directory, "new.json"), current.config, { legacyPath: legacy }).resetEpoch(), /protected local-state recovery/);
  assert.equal(await readFile(`${legacy}.lock`, "utf8"), "synthetic-active-legacy-writer");
});

test("reset client uses bounded authenticated reset-only routes and sanitizes private transport failures", async () => {
  const calls = [], config = { apiUrl: "https://api.example.test", kioskToken: "synthetic-token" };
  const client = createFingerprintResetClient(config, { fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ commands: [] }); } });
  await client.commands(); await client.complete("synthetic-reset");
  assert.equal(calls[0].url, "https://api.example.test/kiosk/fingerprint-reset/commands");
  assert.equal(calls[1].url, "https://api.example.test/kiosk/fingerprint-reset/commands/synthetic-reset/acknowledge");
  assert.deepEqual(JSON.parse(calls[1].options.body), { completed: true });
  assert.equal(calls[0].options.redirect, "error"); assert.equal(calls[0].options.headers.authorization, "Bearer synthetic-token");
  assert.throws(() => client.complete("../private"), /Invalid/);
  assert.equal(client.manifest, undefined); assert.equal(client.decisions, undefined); assert.equal(client.acknowledge, undefined);
  for (const fetchImpl of [async () => new Response("synthetic-private-details", { status: 403 }), async () => new Response("x".repeat(4097))]) {
    await assert.rejects(createFingerprintResetClient(config, { fetchImpl }).commands(), error => !error.message.includes("synthetic-private-details"));
  }
});

test("reset permanently pauses initialized peer sharing without provider or sensor access", async context => {
  const current = await fixture(context), directory = join(current.directory, "peer");
  const binding = { installationId: "synthetic-installation", ...current.config };
  const identities = createFingerprintIdentityStore(join(directory, "identity.json"), binding); await identities.setEnabled(true);
  let calls = 0;
  const controller = createFingerprintSync({ directory, config: current.config, mappings: current.mappings, sensor: {}, templates: {}, withSensor: () => assert.fail("No reset reader operation"), fetchRoster: () => assert.fail("No reset roster operation"),
    client: { configuration: async () => { calls++; throw new Error("Synthetic offline"); } } });
  await controller.stopForReset(); assert.equal((await identities.status()).enabled, false); assert.equal((await controller.tick()).status, "reset"); assert.equal(calls, 0);
});

test("local mapping edits preserve retired review markers and cannot fabricate a new enrollment or stable identity", async context => {
  const current = await fixture(context);
  const review = { manifestId: "a".repeat(64), revision: 1, vaultId: null, reviewGrantId: "retired-grant", mappingDigest: "b".repeat(64), slotProof: "c".repeat(64), originalMemberId: "OLD", approvedMemberId: "SYN-001", rosterId: "stable-one", sourceSlot: 1 };
  const old = { memberId: "SYN-001", rosterId: "stable-one", finger: "index", enrollment: { id: "11111111-1111-4111-8111-111111111111", occurredAt: 1 }, review };
  await current.mappings.replace({ 1: old });
  await current.mappings.replaceFromMaintenance({ 1: { ...old, review: undefined }, 2: { memberId: "SYN-002", rosterId: "invented", finger: "thumb", enrollment: old.enrollment } });
  const next = await current.mappings.read(); assert.deepEqual(next[1], old); assert.equal(freshFingerprintSource(next[1]), false);
  assert.equal(next[2].rosterId, undefined); assert.equal(next[2].enrollment, undefined);
});

test("deliberate two-scan re-enrollment after mapping reset creates fresh authority in the same explicitly confirmed occupied slot", async context => {
  const current = await fixture(context); current.models.set(1, new Uint8Array(1536).fill(44)); current.models.set(7, new Uint8Array(1536).fill(45));
  await current.mappings.replace({ 1: { memberId: "SYN-001", finger: "old" } }); current.reset(); const controller = current.factory(); await controller.tick();
  let writes = 0;
  const sensor = { enroll: async (slot, options) => {
    if (current.models.has(slot) && options.replaceExisting !== true) throw new Error("Confirm occupied slot replacement");
    writes++; current.models.set(slot, new Uint8Array(1536).fill(46));
  } };
  const input = { sensor, mappings: current.mappings, withSensor: current.withSensor, slot: 1, memberId: "SYN-001", rosterId: "stable-one", finger: "index", isEnrollmentAllowed: controller.enrollmentAllowed };
  await assert.rejects(enrollFingerprint(input), /Confirm occupied/); assert.equal(writes, 0);
  await enrollFingerprint({ ...input, replaceExisting: true }); assert.equal(writes, 1);
  assert.equal(freshFingerprintSource((await current.mappings.read())[1]), true); assert.equal(current.models.get(7)[0], 45);
});
