import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";
import { createKioskPollCloud } from "./fixtures/kiosk-poll-cloud.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 20000, description = "runtime condition", diagnostics) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(100); }
  assert.fail(`Timed out waiting for ${description}${diagnostics ? ": " + JSON.stringify(await diagnostics()) : ""}`);
}
async function startKiosk(root, device, apiUrl) {
  const directory = join(root, device); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const env = { ...process.env, NODE_ENV: "development", LANCERLOGIN_KIOSK_PORT: "0", LANCERLOGIN_KIOSK_HOST: "127.0.0.1", LANCERLOGIN_SENSOR_PATH: "synthetic" };
  for (const [key, name] of Object.entries({ CONFIG: "pairing.json", NETWORK_PIN: "network-pin.json", QUEUE: "attendance-queue.json", MAPPINGS: "slot-mappings.json", BRANDING: "branding.json", AUTHENTICATION: "authentication.json", CREDENTIAL_MAPPINGS: "credential-mappings.json", ROSTER_CACHE: "roster-cache.json", FINGERPRINT_SYNC: "fingerprint-sync", FINGERPRINT_VAULT: "fingerprint-vault", FINGERPRINT_RESET: "fingerprint-reset", FINGERPRINT_REVIEW: "fingerprint-review" })) env[`LANCERLOGIN_${key}`] = join(directory, name);
  await writeFile(env.LANCERLOGIN_CONFIG, JSON.stringify({ apiUrl, kioskId: device, pairingId: device, kioskToken: device, kioskName: `Synthetic ${device}` }), { mode: 0o600 });
  await createNetworkPinStore(env.LANCERLOGIN_NETWORK_PIN).set("123456");
  const child = fork(new URL("./fixtures/kiosk-poll-runtime-child.mjs", import.meta.url), [], { env, execArgv: ["--experimental-test-module-mocks"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostics = ""; child.stderr.on("data", chunk => { diagnostics += chunk; });
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Synthetic child startup timed out: ${diagnostics}`)), 5000); child.on("message", message => { if (message.ready) { clearTimeout(timer); resolve(message.port); } }); child.once("exit", () => { clearTimeout(timer); reject(new Error(`Synthetic child failed: ${diagnostics}`)); }); });
  let sequence = 0;
  return { directory, child,
    request: (path, body, method = body === undefined ? "GET" : "POST") => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) }),
    reader: (input = {}) => { const id = ++sequence; return new Promise(resolve => { const listener = message => { if (message.id === id) { child.off("message", listener); resolve(message); } }; child.on("message", listener); child.send({ ...input, id }); }); },
    mappings: () => readFile(env.LANCERLOGIN_MAPPINGS, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return {}; throw error; }),
    async stop() { if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; } },
  };
}

test("two real services preserve timers, encrypted transfer, offline scans, commands and reset across a planned drained restart", { timeout: 150000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "kiosk-poll-service-")), cloud = await createKioskPollCloud(), kiosks = [];
  t.after(async () => { for (const kiosk of kiosks) await kiosk.stop(); await cloud.close(); await rm(root, { recursive: true, force: true }); });
  for (const [path, body] of [["/admin/kiosks/fingerprint-sync", { enabled: true }], ["/admin/kiosks/fingerprint-vault", { enabled: true, confirmation: "ENABLE CLOUD FINGERPRINT STORAGE" }]]) {
    const result = await cloud.admin(path, body, "PATCH"); assert.equal(result.status, 200, await result.text());
  }
  const one = await startKiosk(root, "one", cloud.apiUrl); kiosks.push(one);
  const two = await startKiosk(root, "two", cloud.apiUrl); kiosks.push(two);
  const started = Date.now();
  for (const kiosk of kiosks) {
    assert.equal((await kiosk.request("/network/unlock", { pin: "123456" })).status, 200);
    assert.equal((await kiosk.request("/operator-presence", { action: "enter", pageId: "synthetic-maintenance", mode: "maintenance" })).status, 200);
    await until(async () => (await (await kiosk.request("/health")).json()).fingerprintSync.reset.state === "ready", 10000, "initial reset authority");
    assert.equal((await kiosk.request("/fingerprint-sync", { enabled: true }, "PATCH")).status, 200);
  }
  assert.equal((await one.request("/enroll", { memberId: "synthetic-member", slot: 0 })).status, 201);
  await one.reader({ present: false });
  await until(async () => Object.values(await two.mappings()).some(mapping => mapping.memberId === "synthetic-member" && mapping.rosterId === "member"), 35000, "encrypted vault enrollment transfer");
  assert.equal((await two.reader()).imports, 1);
  const template = await cloud.db.prepare("SELECT ciphertext,nonce FROM kiosk_fingerprint_vault_templates").first();
  assert.ok(template?.ciphertext); assert.notEqual(template.ciphertext, Buffer.alloc(1536, 17).toString("base64"));
  cloud.offline.add("two");
  await two.request("/operator-presence", { action: "leave", pageId: "synthetic-maintenance", generation: 1, mode: "maintenance" });
  const presence = await (await two.request("/operator-presence", { action: "enter", pageId: "synthetic-attendance", mode: "attendance" })).json();
  await two.reader({ present: false }); await wait(500); await two.reader({ present: true, slot: 0 });
  await until(async () => (await (await two.request("/health")).json()).pendingEvents === 1, 5000, "durable offline recognition scan");
  await two.reader({ present: false });
  // An unavailable vault key must not hold a general command or the other kiosk.
  const originalKey = await cloud.db.prepare("SELECT key_id AS keyId FROM kiosk_fingerprint_vault_settings").first();
  await cloud.db.prepare("UPDATE kiosk_fingerprint_vault_settings SET key_id=?").bind("f".repeat(64)).run();
  await cloud.db.prepare("INSERT INTO kiosk_commands(id,installation_id,kiosk_id,command_type,created_by,created_at) VALUES('synthetic-reload','primary','one','reload_display','admin',?)").bind(new Date().toISOString()).run();
  await until(async () => Boolean((await cloud.db.prepare("SELECT success FROM kiosk_commands WHERE id='synthetic-reload'").first())?.success), 8000, "command during fingerprint failure");
  await until(async () => (await (await one.request("/health")).json()).fingerprintSync.vault.state === "unavailable", 18000, "isolated unavailable vault section");
  cloud.offline.delete("two");
  await cloud.db.prepare("UPDATE kiosk_fingerprint_vault_settings SET key_id=?").bind(originalKey.keyId).run();
  // Wait for the actual sixty-second production timer, without accelerating it.
  await until(() => ["one", "two"].every(device => cloud.records.filter(record => record.device === device && record.path === "/kiosk/heartbeat" && record.status === 200).length >= 2), 65000, "sixty-second heartbeats and queue recovery");
  await until(async () => (await (await two.request("/health")).json()).pendingEvents === 0, 5000, "offline queue acknowledgement");
  assert.equal((await cloud.db.prepare("SELECT count(*) AS n FROM attendance_events WHERE source='kiosk'").first()).n, 1);
  for (const device of ["one", "two"]) {
    const calls = cloud.records.filter(record => record.device === device && record.path === "/kiosk/poll");
    assert.ok(calls.length >= 13, `${device} must poll commands every five seconds`);
    for (let n = 1; n < calls.length; n++) assert.ok(calls[n].time - calls[n - 1].time < 7000, `${device} command cadence must survive section failures`);
    assert.ok(calls.filter(record => record.fingerprints).length >= 5);
    assert.ok(calls.filter(record => record.configuration).length >= 2);
    assert.equal(cloud.records.filter(record => record.device === device && ["/kiosk/commands", "/kiosk/config", "/kiosk/fingerprint-reset/commands"].includes(record.path)).length, 0);
  }
  const reset = await cloud.admin("/admin/kiosks/fingerprint-reset", { resetId: "synthetic-reset", confirmation: "RESET ALL FINGERPRINT MAPPINGS" }); assert.equal(reset.status, 200, await reset.text());
  await until(async () => (await cloud.db.prepare("SELECT count(*) AS n FROM kiosk_fingerprint_reset_commands WHERE acknowledged_at IS NOT NULL").first()).n === 2, 22000, "both durable reset acknowledgements");
  for (const kiosk of kiosks) { assert.deepEqual(await kiosk.mappings(), {}); assert.deepEqual((await kiosk.reader()).occupied, [0]); }
  assert.equal((await two.reader({ quiesce: true })).quiesced, true, "Planned restart must finish local reset work after the cloud acknowledgement");
  if (process.platform !== "linux") assert.deepEqual((await readdir(two.directory, { recursive: true })).filter(name => name.endsWith(".lock")), [], "Planned restart must close marker locks without deleting them");
  await two.stop(); const restarted = await startKiosk(root, "two", cloud.apiUrl); kiosks.push(restarted);
  await until(async () => (await (await restarted.request("/health")).json()).fingerprintSync.reset.state === "ready", 5000, "restart reset recovery", async () => ({ reset: (await (await restarted.request("/health")).json()).fingerprintSync.reset, unfinishedState: (await readdir(restarted.directory, { recursive: true })).filter(name => /\.(lock|tmp)$/.test(name)), recentRequests: cloud.records.filter(record => record.device === "two").slice(-6).map(({ path, status, fingerprints, configuration }) => ({ path, status, fingerprints, configuration })) }));
  assert.deepEqual(await restarted.mappings(), {}); assert.deepEqual((await restarted.reader()).occupied, [0]);
  assert.equal((await cloud.db.prepare("SELECT count(*) AS n FROM attendance_events WHERE source='kiosk'").first()).n, 1);
  console.log(JSON.stringify({ evidence: "two_production_kiosk_services_real_worker_d1", elapsedMs: Date.now() - started, requests: cloud.records.length, reads: cloud.records.reduce((n, record) => n + (record.reads ?? 0), 0), writes: cloud.records.reduce((n, record) => n + (record.writes ?? 0), 0), timers: "unmodified 5/15/60 seconds", hardware: "synthetic reader only", restart: "planned after installation activity drainage; no abrupt-death claim" }));
});
