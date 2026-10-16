import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprintDiagnostic, fingerprintFailureReason } from "../apps/kiosk/src/fingerprint-diagnostics.mjs";
import { createFingerprintCloudClient } from "../apps/kiosk/src/fingerprint-cloud-client.mjs";
import { createFingerprintVaultClient } from "../apps/kiosk/src/fingerprint-vault-client.mjs";
import { createFingerprintSync } from "../apps/kiosk/src/fingerprint-sync.mjs";
import { createFingerprintVault } from "../apps/kiosk/src/fingerprint-vault.mjs";
import { createFingerprintReset } from "../apps/kiosk/src/fingerprint-reset.mjs";
import { generateFingerprintIdentity, fingerprintPublicIdentity, fingerprintIdentityId, sealFingerprintTemplate } from "../apps/kiosk/src/fingerprint-envelope.mjs";

const sensitive = "synthetic-secret-template-token-path";
const config = { apiUrl: "https://example.invalid", kioskToken: sensitive, kioskId: "synthetic-kiosk", pairingId: "synthetic-pair" };
const roster = { members: [{ memberId: "synthetic-member", rosterId: "stable-member" }] };
const syncId = "a".repeat(64);
const now = 1_700_000_000_000;
const noSensor = new Proxy({}, { get() { return () => assert.fail("Diagnostics must not access the reader"); } });

test("healthy idle peer polls register once and recover registration after a relay error", async context => {
  let registrations = 0, configurations = 0, rejectPending = false, instant = now;
  const sync = createFingerprintSync({ directory: await temporary(context), config, sensor: noSensor, templates: noSensor,
    mappings: { read: async () => ({}) }, withSensor: operation => operation(), fetchRoster: async () => roster, now: () => instant,
    client: { configuration: async () => { configurations++; return { enabled: true, syncId }; }, register: async identity => { registrations++; return { registered: true, fingerprint: identity.fingerprint }; },
      pending: async () => { if (rejectPending) throw new Error("Synthetic relay outage"); return { syncId, deliveries: [] }; } },
  });
  await sync.setEnabled(true);
  for (let i = 0; i < 8; i++) await sync.tick();
  assert.equal(registrations, 1);
  assert.equal(configurations, 1);
  instant += 300000; await sync.tick(); assert.equal(registrations, 2);
  rejectPending = true; await sync.tick(); rejectPending = false; await sync.tick();
  assert.equal(registrations, 3);
  await sync.setEnabled(false); await sync.setEnabled(true);
  assert.equal(registrations, 4);
});

test("peer and cloud controllers refuse an expired shared roster before any transfer", async context => {
  const expired = async () => ({ ...roster, freshUntil: now - 1 });
  const peer = createFingerprintSync({ directory: await temporary(context), config, sensor: noSensor, templates: noSensor,
    mappings: { read: async () => ({}) }, withSensor: operation => operation(), fetchRoster: expired, now: () => now,
    client: { configuration: async () => ({ enabled: true, syncId }), register: async identity => ({ registered: true, fingerprint: identity.fingerprint }), pending: async () => ({ syncId, deliveries: [] }) },
  });
  await peer.setEnabled(true); await peer.tick();
  assert.equal(peer.diagnostics().reasonCode, "roster_unavailable");
  const vault = createFingerprintVault({ directory: await temporary(context), config, sensor: noSensor, templates: noSensor,
    mappings: { read: async () => ({}) }, withSensor: operation => operation(), fetchRoster: expired, now: () => now,
    client: { configuration: async () => ({ enabled: true, vaultId: syncId, format: "r503-model-1536" }), list: async () => assert.fail("Expired roster cannot authorize cloud import") },
  });
  await vault.tick(); assert.equal(vault.diagnostics().reasonCode, "roster_unavailable");
});

test("a delivery generation change blocks sharing before roster or sensor access", async context => {
  let generation = syncId, rosterReads = 0;
  const peer = createFingerprintSync({ directory: await temporary(context), config, sensor: noSensor, templates: noSensor,
    mappings: { read: async () => ({}) }, withSensor: operation => operation(), fetchRoster: async () => { rosterReads++; return roster; }, now: () => now,
    client: { configuration: async () => ({ enabled: true, syncId }), register: async identity => ({ registered: true, fingerprint: identity.fingerprint }), pending: async () => ({ syncId: generation, deliveries: [] }) },
  });
  await peer.setEnabled(true); await peer.tick(); assert.equal(rosterReads, 1);
  generation = "b".repeat(64);
  assert.equal((await peer.tick()).reasonCode, "identity_mismatch"); assert.equal(rosterReads, 1);
});

async function temporary(context) {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-synthetic-diagnostics-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("diagnostic projection excludes identifiers, errors and sensitive extra fields", () => {
  const result = fingerprintDiagnostic("peer", { status: "ready", reasonCode: sensitive, lastAttemptAt: sensitive,
    lastSuccessAt: new Date(now).toISOString(), errors: 2, received: Infinity, uploaded: -1, completed: 2_000_000,
    token: sensitive, template: sensitive, error: new Error(sensitive), resetEpoch: sensitive }, now);
  assert.equal(JSON.stringify(result).includes(sensitive), false);
  assert.equal(result.lastAttemptAt, null);
  assert.equal(result.reasonCode, "ready");
  assert.equal(result.completed, 1_000_000);
  assert.equal(result.received, undefined);
  assert.equal(result.uploaded, undefined);
  assert.equal(fingerprintFailureReason(new Error(sensitive), "network_unavailable"), "network_unavailable");
  assert.equal(fingerprintFailureReason({ reasonCode: sensitive, status: 401 }), "authentication_failed");
  assert.equal(fingerprintFailureReason({ status: 403 }), "authentication_failed");
  assert.equal(fingerprintFailureReason({ name: "TimeoutError" }), "request_timeout");
  assert.equal(fingerprintFailureReason({ code: "EACCES" }), "local_state_review");
});

test("stale success remains historical while blocked recovery cannot become ready", () => {
  const values = { status: "ready", reasonCode: "ready", lastSuccessAt: new Date(now).toISOString() };
  assert.equal(fingerprintDiagnostic("vault", values, now + 120_001).state, "stale");
  assert.equal(fingerprintDiagnostic("vault", values, now + 120_001).reasonCode, "stale");
  assert.equal(fingerprintDiagnostic("reset", { ...values, blocked: true }, now).state, "blocked");
  assert.equal(fingerprintDiagnostic("peer", { status: "unavailable", reasonCode: "local_state_review" }, now).state, "blocked");
});

for (const [name, create] of [["peer", createFingerprintCloudClient], ["vault", createFingerprintVaultClient]]) {
  test(`${name} client classifies failures without exposing cloud bodies or credentials`, async () => {
    for (const [fetchImpl, reason] of [
      [async () => new Response(sensitive, { status: 401 }), "authentication_failed"],
      [async () => new Response(sensitive, { status: 403 }), "authentication_failed"],
      [async () => { throw Object.assign(new Error(sensitive), { name: "TimeoutError" }); }, "request_timeout"],
      [async () => { throw new Error(sensitive); }, "network_unavailable"],
      [async () => new Response(sensitive), "invalid_response"],
    ]) {
      await assert.rejects(create(config, { fetchImpl }).configuration(), error => {
        assert.equal(error.reasonCode, reason);
        assert.equal(error.message.includes(sensitive), false);
        assert.equal(JSON.stringify(error).includes(sensitive), false);
        return true;
      });
    }
  });
}

test("peer diagnostics distinguish no trust, missing identity, roster failure and offline disablement", async context => {
  const directory = await temporary(context);
  let offline = false, rosterOffline = false, entries = {};
  const controller = createFingerprintSync({ directory, config, sensor: noSensor, templates: noSensor,
    mappings: { read: async () => entries }, withSensor: operation => operation(), now: () => now,
    fetchRoster: async () => { if (rosterOffline) throw new Error(sensitive); return roster; },
    client: { configuration: async () => { if (offline) throw new Error(sensitive); return { enabled: true, syncId }; },
      register: async identity => ({ registered: true, fingerprint: identity.fingerprint }), peers: async () => ({ peers: [] }),
      pending: async () => ({ deliveries: [] }), revoke: async () => { if (offline) throw new Error(sensitive); } },
  });
  assert.equal(controller.diagnostics().state, "starting");
  await controller.setEnabled(true);
  assert.equal((await controller.tick()).reasonCode, "no_approved_peer");
  entries = { 1: { memberId: "synthetic-member", finger: "legacy" } };
  const missing = await controller.tick();
  assert.equal(missing.missingIdentityMappings, 1);
  assert.equal(missing.reasonCode, "enrollment_identity_missing");
  assert.equal(entries[1].rosterId, undefined);
  rosterOffline = true;
  const failure = await controller.tick();
  assert.equal(failure.reasonCode, "roster_unavailable");
  assert.equal(failure.lastSuccessAt, new Date(now).toISOString());
  assert.equal(JSON.stringify(failure).includes(sensitive), false);
  offline = true;
  assert.equal((await controller.tick()).reasonCode, "network_unavailable");
  assert.equal((await controller.setEnabled(false)).enabled, false);
  assert.equal((await controller.status()).enabled, false);
});

test("vault reports missing identities without exporting and separates stale health from network failure", async context => {
  const directory = await temporary(context);
  let clock = now, offline = false, entries = { 1: { memberId: "synthetic-member", finger: "legacy" } };
  const controller = createFingerprintVault({ directory, config, sensor: noSensor, templates: noSensor,
    mappings: { read: async () => entries }, withSensor: operation => operation(), fetchRoster: async () => roster, now: () => clock,
    client: { configuration: async () => { if (offline) throw new Error(sensitive); return { enabled: true, vaultId: syncId, format: "r503-model-1536" }; }, list: async () => ({ vaultId: syncId, fingerprints: [] }) },
  });
  assert.equal(controller.diagnostics().state, "starting");
  const missing = await controller.tick();
  assert.equal(missing.reasonCode, "ready");
  assert.equal(missing.state, "ready");
  assert.equal(missing.missingIdentityMappings, 1);
  assert.equal(entries[1].rosterId, undefined);
  for (const mapping of [
    { memberId: "inactive-member" },
    { memberId: "synthetic-member", rosterId: "different-identity" },
    { memberId: "synthetic-member", review: { required: true } },
  ]) {
    entries = { 1: mapping };
    const review = await controller.tick();
    assert.equal(review.status, "needs_attention");
    assert.equal(review.reasonCode, "mapping_review");
  }
  entries = {};
  assert.equal((await controller.tick()).state, "ready");
  clock += 120_001;
  assert.equal(controller.diagnostics().state, "stale");
  offline = true;
  const failed = await controller.tick();
  assert.equal(failed.reasonCode, "network_unavailable");
  assert.equal(failed.lastSuccessAt, new Date(now).toISOString());
  await controller.stopForReset();
  assert.equal(controller.diagnostics().state, "blocked");
});

test("reset diagnostics expose protected-state failure without clearing the legacy lock", async context => {
  const directory = await temporary(context), pairingDirectory = join(directory, `${config.kioskId}-${config.pairingId}`);
  await mkdir(pairingDirectory, { mode: 0o700 });
  const lockPath = join(pairingDirectory, "reset.json.lock");
  await writeFile(lockPath, sensitive, { mode: 0o600 });
  const controller = createFingerprintReset({ directory, config, mappings: { replace: () => assert.fail("No state mutation") },
    withSensor: operation => operation(), client: { commands: () => assert.fail("Local recovery blocks polling") }, now: () => now });
  const result = await controller.tick();
  assert.equal(result.blocked, true);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "local_state_review");
  assert.equal(result.lastSuccessAt, null);
  assert.equal(JSON.stringify(result).includes(sensitive), false);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(lockPath, "utf8"), sensitive);
});

test("reset polling retains authentication failure and never reports successful attendance as sync health", async context => {
  const directory = await temporary(context);
  const controller = createFingerprintReset({ directory, config, mappings: {}, withSensor: operation => operation(), now: () => now,
    client: { commands: async () => { throw Object.assign(new Error(sensitive), { status: 403 }); } } });
  const result = await controller.tick();
  assert.equal(result.reasonCode, "authentication_failed");
  assert.equal(result.blocked, true);
  assert.equal(result.lastSuccessAt, null);
});

test("peer configuration changes and malformed responses remain distinct from an offline cloud", async context => {
  const directory = await temporary(context);
  let remote = { enabled: true, syncId };
  const controller = createFingerprintSync({ directory, config, sensor: noSensor, templates: noSensor,
    mappings: { read: async () => ({}) }, withSensor: operation => operation(), fetchRoster: async () => roster, now: () => now,
    client: { configuration: async () => remote, register: async identity => ({ registered: true, fingerprint: identity.fingerprint }), pending: async () => ({ deliveries: [] }) },
  });
  await controller.setEnabled(true);
  remote = { enabled: true, syncId: "b".repeat(64) };
  assert.equal((await controller.tick()).reasonCode, "identity_mismatch");
  assert.equal(controller.diagnostics().state, "blocked");
  remote = { enabled: true, syncId: sensitive };
  assert.equal((await controller.tick()).reasonCode, "invalid_response");
  assert.equal(JSON.stringify(controller.diagnostics()).includes(sensitive), false);
});

test("Linux reset diagnostics accept persistent kernel lock directories", { skip: process.platform !== "linux" }, async context => {
  const directory = await temporary(context);
  const controller = createFingerprintReset({ directory, config, mappings: {}, withSensor: operation => operation(), now: () => now,
    client: { commands: async () => ({ commands: [] }) } });
  assert.equal((await controller.tick()).state, "ready");
  assert.equal((await controller.tick()).state, "ready");
  const { lstat } = await import("node:fs/promises");
  assert.equal((await lstat(join(directory, `${config.kioskId}-${config.pairingId}`, "reset.json.lock"))).isDirectory(), true);
});

for (const corruption of ["outbox.json", "outbox.json.lock"]) {
  test(`peer diagnostics block on protected ${corruption} without touching the reader or acknowledging transfers`, async context => {
    const directory = await temporary(context);
    const controller = createFingerprintSync({ directory, config, sensor: noSensor, templates: noSensor,
      mappings: { read: async () => ({}) }, withSensor: operation => operation(), now: () => now,
      fetchRoster: async () => roster,
      client: { configuration: async () => ({ enabled: true, syncId }),
        register: async identity => ({ registered: true, fingerprint: identity.fingerprint }),
        pending: async () => assert.fail("Blocked local state must stop transfer polling") },
    });
    await controller.setEnabled(true);
    const path = join(directory, corruption);
    await writeFile(path, sensitive, { mode: 0o600 });
    const result = await controller.tick();
    assert.equal(result.reasonCode, "local_state_review");
    assert.equal(result.state, "blocked");
    assert.equal(result.lastSuccessAt, null);
    assert.equal(JSON.stringify(result).includes(sensitive), false);
    assert.equal(await readFile(path, "utf8"), sensitive);
  });
}

test("authenticated peer import reports a corrupt local journal as blocked without sensor writes or acknowledgement", async context => {
  const directory = await temporary(context), sender = await generateFingerprintIdentity();
  const publicIdentity = fingerprintPublicIdentity(sender), fingerprint = fingerprintIdentityId(publicIdentity);
  const peer = { installationId: syncId, kioskId: "synthetic-source", pairingId: "synthetic-source-pair", name: "Synthetic source", publicIdentity, fingerprint };
  let delivery;
  const controller = createFingerprintSync({ directory, config, sensor: { occupiedSlots: async () => [] }, templates: noSensor,
    mappings: { read: async () => ({}) }, withSensor: operation => operation(), now: () => now, fetchRoster: async () => roster,
    client: { configuration: async () => ({ enabled: true, syncId }),
      register: async identity => ({ registered: true, fingerprint: identity.fingerprint }),
      peers: async () => ({ peers: [peer] }), pending: async () => ({ deliveries: [{ ...delivery, context: { ...delivery.context, transferId: "a-invalid-signature" } }, delivery] }),
      acknowledge: async () => assert.fail("Corrupt journal must not acknowledge the transfer") },
  });
  await controller.setEnabled(true); const recipient = await controller.status();
  await controller.approvePeer(peer.kioskId, fingerprint);
  delivery = sealFingerprintTemplate(Buffer.alloc(1536, 42), { sender, recipient: recipient.publicIdentity, now,
    context: { installationId: syncId, senderId: peer.kioskId, senderPairingId: peer.pairingId, senderKeyId: fingerprint,
      recipientId: config.kioskId, recipientPairingId: config.pairingId, recipientKeyId: recipient.fingerprint,
      memberId: "synthetic-member", enrollmentId: "synthetic-enrollment", transferId: "synthetic-transfer", revision: 1, issuedAt: now, expiresAt: now + 60000 } });
  const path = join(directory, "received.json"); await writeFile(path, sensitive, { mode: 0o600 });
  const result = await controller.tick();
  assert.equal(result.reasonCode, "local_state_review"); assert.equal(result.state, "blocked");
  assert.equal(result.received, 0); assert.equal(result.lastSuccessAt, null);
  assert.equal(JSON.stringify(result).includes(sensitive), false);
  assert.equal(await readFile(path, "utf8"), sensitive);
});

test("vault importer reports an actual legacy journal lock as blocked and preserves the lock", async context => {
  const directory = await temporary(context);
  const journalDirectory = join(directory, `${config.kioskId}-${config.pairingId}`, syncId);
  await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  const path = join(journalDirectory, "received.json.lock");
  await writeFile(path, sensitive, { mode: 0o600 });
  const controller = createFingerprintVault({ directory, config, sensor: { occupiedSlots: async () => [] }, templates: noSensor,
    mappings: { read: async () => ({}) }, withSensor: operation => operation(), fetchRoster: async () => roster, now: () => now,
    client: { configuration: async () => ({ enabled: true, vaultId: syncId, format: "r503-model-1536" }),
      list: async () => ({ vaultId: syncId, fingerprints: [{ fingerprintId: "b".repeat(64), memberId: "synthetic-member", rosterId: "stable-member" }, { fingerprintId: "c".repeat(64), memberId: "synthetic-member", rosterId: "stable-member" }] }),
      template: async fingerprintId => fingerprintId === "b".repeat(64) ? {} : ({ vaultId: syncId, fingerprintId: "c".repeat(64), memberId: "synthetic-member", rosterId: "stable-member", format: "r503-model-1536", template: Buffer.alloc(1536, 42).toString("base64") }) },
  });
  const result = await controller.tick();
  assert.equal(result.reasonCode, "local_state_review"); assert.equal(result.state, "blocked");
  assert.equal(result.received, 0); assert.equal(result.lastSuccessAt, null);
  assert.equal(JSON.stringify(result).includes(sensitive), false);
  assert.equal(await readFile(path, "utf8"), sensitive);
});
