import test from "node:test";
import assert from "node:assert/strict";
import { createKioskPollClient, createKioskPollScheduler } from "../apps/kiosk/src/kiosk-poll.mjs";
import { createFingerprintVault } from "../apps/kiosk/src/fingerprint-vault.mjs";
import { createMappingStore } from "../apps/kiosk/src/mapping-store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = { apiUrl: "https://example.test", kioskId: "synthetic-kiosk", pairingId: "synthetic-pair", kioskToken: "synthetic-token" };
const settle = () => new Promise(resolve => setImmediate(resolve));
const id = "a".repeat(64), fingerprintId = "b".repeat(64);
const reply = () => ({ protocol: 1, command: null, configuration: { kiosk: { id: config.kioskId, name: "Synthetic kiosk" }, settings: { authenticationMethod: "fingerprint" } }, fingerprints: {
  reset: { status: "ok", commands: [] }, roster: { status: "ok", revision: 1, notModified: false, members: [{ memberId: "synthetic", rosterId: "identity" }] },
  peer: { status: "ok", enabled: true, syncId: id, deliveries: [] }, vault: { status: "ok", enabled: true, vaultId: id, format: "r503-model-1536", catalogRevision: 1 },
} });
const manifest = () => ({ vaultId: id, fingerprints: [{ fingerprintId, memberId: "synthetic", rosterId: "identity" }] });

test("enrollment opt-in returns a session without changing legacy command behavior", async () => {
  const urls = [], enrollment = { id: "synthetic-session" };
  const client = createKioskPollClient(config, { enrollment: true, fetchImpl: async url => { urls.push(new URL(url)); return Response.json({ ...reply(), enrollment }); } });
  assert.deepEqual((await client.poll()).enrollment, enrollment);
  assert.equal(urls[0].searchParams.get("enrollment"), "1");
});

test("old servers reject enrollment opt-in once then keep existing polling working", async () => {
  const urls = [];
  const client = createKioskPollClient(config, { enrollment: true, fetchImpl: async url => {
    const parsed = new URL(url); urls.push(parsed);
    return parsed.searchParams.has("enrollment") ? Response.json({ error: "Unsupported" }, { status: 400 }) : Response.json(reply());
  } });
  assert.equal((await client.poll()).enrollmentUnsupported, true);
  assert.equal((await client.poll()).command, null);
  assert.deepEqual(urls.map(url => url.searchParams.has("enrollment")), [true, false, false]);
});

test("enrollment fallback discovers sessions after an API upgrade without restarting polling", async () => {
  let remote = null; const seen = [], commands = [];
  const scheduler = createKioskPollScheduler({ client: { poll: async () => ({ command: null, enrollmentUnsupported: true, configuration: () => ({}) }) },
    commands: value => commands.push(value), configuration: () => {}, fingerprints: () => {}, enrollment: value => seen.push(value),
    legacy: { enrollment: async () => seen.push(remote) } });
  await scheduler.tick(); await settle(); remote = { id: "synthetic-upgraded-session" };
  await scheduler.tick(); await settle();
  assert.deepEqual(seen, [null, remote]); assert.deepEqual(commands, [null, null]); assert.equal(scheduler.legacy(), false);
});

test("poll revision revalidation preserves the original roster deadline and replays bounded manifest pages", async () => {
  let time = 1000, body = reply(), reads = 0;
  const urls = [], client = createKioskPollClient(config, { now: () => time, fetchImpl: async url => { urls.push(new URL(url)); return Response.json(body); } });
  const first = await client.poll({ fingerprints: true, configuration: true });
  const roster = await first.fingerprints.roster(); roster.members[0].memberId = "changed";
  assert.equal((await first.fingerprints.roster()).members[0].memberId, "synthetic");
  const read = async () => { reads++; return manifest(); };
  const page = await first.fingerprints.vault.list(undefined, read); page.fingerprints.length = 0;
  assert.equal((await first.fingerprints.vault.list(undefined, read)).fingerprints.length, 1); assert.equal(reads, 1);
  time += 15000; body.fingerprints.roster = { status: "ok", revision: 1, notModified: true };
  const second = await client.poll({ fingerprints: true });
  assert.equal(urls[1].searchParams.get("rosterRevision"), "1");
  assert.equal((await first.fingerprints.roster()).freshUntil, 61000);
  assert.equal((await second.fingerprints.roster()).freshUntil, 76000);
  await second.fingerprints.vault.list(undefined, read); assert.equal(reads, 1);
  body.fingerprints.vault.catalogRevision++;
  const third = await client.poll({ fingerprints: true }); await third.fingerprints.vault.list(undefined, read); assert.equal(reads, 2);
  time = 76000; await assert.rejects(second.fingerprints.roster);
});

test("poll transport and malformed roster failures revoke cached authority without legacy fallback", async () => {
  let body = reply(), status = 200;
  const client = createKioskPollClient(config, { fetchImpl: async () => Response.json(body, { status }) });
  const first = await client.poll({ fingerprints: true });
  status = 403; await assert.rejects(client.poll({ fingerprints: true })); await assert.rejects(first.fingerprints.roster);
  status = 200; body.fingerprints.roster = { status: "ok", revision: 1, notModified: true };
  const second = await client.poll({ fingerprints: true }); await assert.rejects(second.fingerprints.roster);
  body = reply(); body.fingerprints.roster.members.push({ memberId: "synthetic", rosterId: "other" });
  const duplicate = await client.poll({ fingerprints: true }); await assert.rejects(duplicate.fingerprints.roster);
  body = {}; await assert.rejects(client.poll());
  for (status of [400, 401, 409, 429, 500, 503]) await assert.rejects(client.poll());
  for (status of [404, 405]) assert.deepEqual(await client.poll(), { unsupported: true });
});

test("reset and vault failures remain separate from command delivery and invalidate manifest reuse", async () => {
  let body = reply(), reads = 0;
  const client = createKioskPollClient(config, { fetchImpl: async () => Response.json(body) });
  const first = await client.poll({ fingerprints: true }); await first.fingerprints.vault.list(undefined, async () => { reads++; return manifest(); });
  body.command = { id: "reload", type: "reload_display" }; body.fingerprints.vault = { status: "unavailable" };
  const second = await client.poll({ fingerprints: true }); assert.equal(second.command.id, "reload"); await assert.rejects(second.fingerprints.vault.configuration);
  assert.deepEqual(await second.fingerprints.reset.commands(), { commands: [] });
  body = reply(); body.fingerprints.reset.commands = [{ id: "reset", kind: "reset_fingerprint_mappings" }];
  const reset = await client.poll({ fingerprints: true }); assert.equal((await reset.fingerprints.reset.commands()).commands.length, 1);
  await assert.rejects(reset.fingerprints.vault.list(undefined, async () => manifest()));
  body = reply(); const restored = await client.poll({ fingerprints: true }); await restored.fingerprints.vault.list(undefined, async () => { reads++; return manifest(); }); assert.equal(reads, 2);
});

test("malformed or out-of-order manifests cannot enter the cache", async () => {
  const client = createKioskPollClient(config, { fetchImpl: async () => Response.json(reply()) });
  const result = await client.poll({ fingerprints: true }); let reads = 0;
  await assert.rejects(result.fingerprints.vault.list(fingerprintId, async () => { reads++; return manifest(); }));
  await assert.rejects(result.fingerprints.vault.list(undefined, async () => ({ vaultId: id, fingerprints: [{ fingerprintId, memberId: "synthetic" }] })));
  await result.fingerprints.vault.list(undefined, async () => { reads++; return manifest(); }); assert.equal(reads, 2);
});

test("scheduler keeps 5/15/60 second cadences and command transport continues during slow transfers", async () => {
  let time = 0, busy = false, finish; const calls = [], fingerprints = [], configurations = [], commands = [];
  const scheduler = createKioskPollScheduler({ now: () => time, client: { poll: async options => { calls.push({ ...options, time }); return { command: null, fingerprints: {}, configuration: () => ({}) }; } }, commands: async command => commands.push(command), configuration: async value => configurations.push(value), fingerprints: async value => { fingerprints.push(value); if (time === 15000) { busy = true; await new Promise(resolve => { finish = resolve; }); busy = false; } }, fingerprintBusy: () => busy, legacy: {}, onError: error => assert.fail(error) });
  for (time = 0; time <= 60000; time += 5000) { if (time === 35000) { finish(); await settle(); } await scheduler.tick(); await settle(); }
  assert.equal(commands.length, 13); assert.equal(configurations.length, 2); assert.equal(fingerprints.length, 5);
  assert.deepEqual(calls.filter(value => value.fingerprints).map(value => value.time), [0, 15000, 35000, 45000, 60000]);
  assert.deepEqual(calls.filter(value => value.configuration).map(value => value.time), [0, 60000]);
});

test("scheduler never overlaps polls, retries due work after failure, and negotiates legacy explicitly", async () => {
  let time = 0, release, requests = 0, legacyCommands = 0, legacyFingerprints = 0;
  const options = [], errors = [];
  const client = { poll: async value => { requests++; options.push(value); if (requests === 1) { await new Promise(resolve => { release = resolve; }); throw new Error("offline"); } return { unsupported: true }; } };
  const scheduler = createKioskPollScheduler({ now: () => time, client, commands: () => assert.fail("unexpected modern command"), configuration: () => {}, fingerprints: () => {}, legacy: { commands: async () => { legacyCommands++; }, configuration: async () => { throw new Error("configuration unavailable"); }, fingerprints: async () => { legacyFingerprints++; } }, onError: error => errors.push(error.message) });
  const one = scheduler.tick(), two = scheduler.tick(); assert.equal(one, two); assert.equal(requests, 1); release(); await one;
  time = 5000; await scheduler.tick(); await settle(); assert.equal(requests, 2); assert.equal(options[1].fingerprints, true); assert.equal(scheduler.legacy(), true);
  time = 10000; await scheduler.tick(); await settle(); assert.equal(requests, 2); assert.equal(legacyCommands, 2); assert.equal(legacyFingerprints, 1); assert.equal(errors.length, 3);
});

test("slow configuration and command application cannot delay independent fingerprint work or command transport", async () => {
  let time = 0, releaseConfig, releaseCommand, requests = 0, commandRuns = 0, fingerprintRuns = 0;
  const errors = [];
  const scheduler = createKioskPollScheduler({ now: () => time,
    client: { poll: async () => { requests++; return { command: { id: "synthetic" }, configuration: () => ({}), fingerprints: {} }; } },
    commands: async () => { commandRuns++; await new Promise(resolve => { releaseCommand = resolve; }); },
    configuration: async () => { await new Promise(resolve => { releaseConfig = resolve; }); throw new Error("sensor unavailable"); },
    fingerprints: async () => { fingerprintRuns++; }, legacy: {}, onError: (error, section) => errors.push(section),
  });
  for (time = 0; time <= 15000; time += 5000) await scheduler.tick();
  assert.equal(requests, 4); assert.equal(commandRuns, 1); assert.equal(fingerprintRuns, 2);
  releaseConfig(); await scheduler.configurationSettled(); assert.deepEqual(errors, ["configuration"]);
  releaseCommand();
});

test("off-grid manual sync and timer jitter preserve the original periodic deadlines", async () => {
  let time = 100; const fingerprints = [], configurations = [];
  const scheduler = createKioskPollScheduler({ now: () => time, client: { poll: async options => { if (options.fingerprints) fingerprints.push(time); if (options.configuration) configurations.push(time); return { command: null, configuration: () => ({}), fingerprints: {} }; } }, commands: () => {}, configuration: () => {}, fingerprints: () => {}, legacy: {} });
  await scheduler.tick(); await settle();
  time = 7000; await scheduler.tick({ forceFingerprints: true }); await settle();
  for (time = 10000; time <= 60000; time += 5000) { await scheduler.tick(); await settle(); }
  assert.deepEqual(fingerprints, [100, 7000, 15000, 30000, 45000, 60000]);
  assert.deepEqual(configurations, [100, 60000]);
});

test("a full 200-template catalog replays all 26 pages without repeated manifest reads", async () => {
  let reads = 0;
  const client = createKioskPollClient(config, { fetchImpl: async () => Response.json(reply()) });
  for (let sweep = 0; sweep < 2; sweep++) for (let page = 0; page < 26; page++) {
    const after = page ? (page * 8).toString(16).padStart(64, "0") : undefined;
    const current = await client.poll({ fingerprints: true });
    const result = await current.fingerprints.vault.list(after, async () => { reads++; return { vaultId: id, fingerprints: Array.from({ length: page === 25 ? 0 : 8 }, (_, index) => ({ fingerprintId: (page * 8 + index + 1).toString(16).padStart(64, "0"), memberId: "synthetic", rosterId: "identity" })) }; });
    assert.equal(result.fingerprints.length, page === 25 ? 0 : 8);
  }
  assert.equal(reads, 26);
});

test("cached manifest replay still detects a missing local mapping or reader template without replacing either", async t => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-poll-recovery-")); t.after(() => rm(root, { recursive: true, force: true }));
  const mappings = createMappingStore(join(root, "mappings.json")), occupied = new Set(); let downloads = 0, imports = 0, manifestReads = 0;
  const poll = createKioskPollClient(config, { fetchImpl: async () => Response.json(reply()) });
  const vault = createFingerprintVault({ directory: join(root, "vault"), config, mappings,
    client: { list: async () => { manifestReads++; return manifest(); }, template: async () => { downloads++; return { vaultId: id, fingerprintId, memberId: "synthetic", rosterId: "identity", format: "r503-model-1536", template: Buffer.alloc(1536, 7).toString("base64") }; } },
    sensor: { occupiedSlots: async () => [...occupied] }, templates: { exportTemplate: async () => new Uint8Array(1536).fill(7), importTemplate: async (slot, bytes) => { assert.equal(bytes.length, 1536); assert.equal(occupied.has(slot), false); occupied.add(slot); imports++; return { slot, verified: true }; } }, withSensor: operation => operation(),
  });
  const tick = async () => { const metadata = (await poll.poll({ fingerprints: true })).fingerprints; return vault.tick({ ...metadata.vault, roster: metadata.roster }); };
  assert.equal((await tick()).received, 1); assert.equal(imports, 1);
  await mappings.replace({}); assert.equal((await tick()).errors, 1); assert.deepEqual(await mappings.read(), {}); assert.deepEqual([...occupied], [0]);
  await mappings.assignIfUnmapped(0, "synthetic", "synced fingerprint", undefined, "identity"); occupied.clear();
  assert.equal((await tick()).errors, 1); assert.equal((await mappings.read())[0].memberId, "synthetic");
  assert.equal(imports, 1); assert.equal(downloads, 1); assert.equal(manifestReads, 1);
});


test("complete catalog cache is revision-bound, fresh-authorized and refuses racing snapshots", async () => {
  let time = 1000, body = reply(), reads = 0;
  const client = createKioskPollClient(config, { now: () => time, fetchImpl: async () => Response.json(body) });
  const read = async revision => { reads++; return { ...manifest(), catalogRevision: revision }; };
  const first = await client.poll({ fingerprints: true });
  const catalog = await first.fingerprints.vault.catalog(read); catalog.fingerprints.length = 0;
  assert.equal((await first.fingerprints.vault.catalog(read)).fingerprints.length, 1); assert.equal(reads, 1);
  time += 15000;
  const second = await client.poll({ fingerprints: true }); await second.fingerprints.vault.catalog(read); assert.equal(reads, 1);
  body.fingerprints.vault.catalogRevision++;
  const changed = await client.poll({ fingerprints: true });
  await assert.rejects(first.fingerprints.vault.catalog(read));
  await assert.rejects(changed.fingerprints.vault.catalog(async () => ({ ...manifest(), catalogRevision: 1 })));
  await changed.fingerprints.vault.catalog(read); assert.equal(reads, 2);
  client.invalidate(); await assert.rejects(changed.fingerprints.vault.catalog(read));
  const next = await client.poll({ fingerprints: true });
  await assert.rejects(next.fingerprints.vault.catalog(async revision => {
    client.invalidate(); return { ...manifest(), catalogRevision: revision };
  }));
  const last = await client.poll({ fingerprints: true }); time += 60000;
  await assert.rejects(last.fingerprints.vault.catalog(read));
});
