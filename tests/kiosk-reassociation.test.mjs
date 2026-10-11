import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstallationActivities, createUnpairingStore } from "../apps/kiosk/src/unpairing-store.mjs";
import { createIdentityScanner } from "../apps/kiosk/src/scanner.mjs";
import { createFileQueue } from "../apps/kiosk/src/file-queue.mjs";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-reassociate-test-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const pinPath = join(root, "network-pin.json");
  await writeFile(pinPath, "synthetic-local-pin", { mode: 0o600 });
  await writeFile(join(root, "pairing.json"), "synthetic-old-pairing", { mode: 0o600 });
  await writeFile(join(root, "slot-mappings.json"), "synthetic-old-mapping", { mode: 0o600 });
  await mkdir(join(root, "fingerprint-sync"), { mode: 0o700 });
  await writeFile(join(root, "fingerprint-sync", "trust.json"), "synthetic-old-trust", { mode: 0o600 });
  return { root, pinPath };
}

test("unpair archives installation state privately and retains the local PIN", async t => {
  const { root, pinPath } = await fixture(t);
  const store = createUnpairingStore(root, { pinPath, statePaths: [join(root, "pairing.json")] });
  assert.deepEqual(await store.inspect(), { recoveryPending: false });
  const result = await store.unpair();
  assert.equal(result.readerTemplatesRetained, true);
  assert.equal(result.localPinRetained, true);
  assert.deepEqual((await readdir(root)).sort(), ["network-pin.json", "reassociation"]);
  assert.equal(await readFile(pinPath, "utf8"), "synthetic-local-pin");
  const archive = join(root, "reassociation", result.archiveId);
  assert.equal(await readFile(join(archive, "slot-mappings.json"), "utf8"), "synthetic-old-mapping");
  assert.equal(await readFile(join(archive, "fingerprint-sync", "trust.json"), "utf8"), "synthetic-old-trust");
  if (process.platform !== "win32") assert.equal((await lstat(archive)).mode & 0o077, 0);
  await writeFile(join(root, "pairing.json"), "synthetic-new-pairing", { mode: 0o600 });
  const next = await store.unpair();
  assert.notEqual(next.archiveId, result.archiveId);
  assert.equal(await readFile(join(archive, "pairing.json"), "utf8"), "synthetic-old-pairing");
  assert.equal(await readFile(join(root, "reassociation", next.archiveId, "pairing.json"), "utf8"), "synthetic-new-pairing");
});

test("an interrupted archive resumes the same transaction without restoring old state", async t => {
  const { root, pinPath } = await fixture(t); let moves = 0;
  const interrupted = createUnpairingStore(root, { pinPath, move: async (source, target) => { if (++moves === 2) throw new Error("synthetic interruption"); await rename(source, target); } });
  await assert.rejects(interrupted.unpair(), /protected local-state recovery/);
  assert.deepEqual(await interrupted.inspect(), { recoveryPending: true });
  const before = JSON.parse(await readFile(join(root, "reassociation", "current.json"), "utf8"));
  const restarted = createUnpairingStore(root, { pinPath });
  const result = await restarted.unpair();
  assert.equal(result.archiveId, before.archiveId);
  assert.deepEqual(await restarted.inspect(), { recoveryPending: false });
  assert.deepEqual((await readdir(root)).sort(), ["network-pin.json", "reassociation"]);
});

test("unsafe paths, symbolic links and damaged recovery journals fail closed", async t => {
  const { root, pinPath } = await fixture(t);
  const outside = createUnpairingStore(root, { pinPath, statePaths: [join(root, "..", "outside.json")] });
  assert.equal((await outside.inspect()).recoveryPending, false);
  await assert.rejects(outside.unpair(), /protected local-state recovery/);
  const linked = join(root, "linked");
  await symlink(join(root, "fingerprint-sync"), linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createUnpairingStore(root, { pinPath }).unpair(), /protected local-state recovery/);
  await rm(linked);
  await mkdir(join(root, "reassociation"), { mode: 0o700 });
  await writeFile(join(root, "reassociation", "current.json"), "{damaged", { mode: 0o600 });
  await assert.rejects(createUnpairingStore(root, { pinPath }).inspect(), /protected local-state recovery/);
  assert.equal(await readFile(join(root, "pairing.json"), "utf8"), "synthetic-old-pairing");
});

test("activity pause drains in-flight work and rejects new installation operations", async () => {
  const activities = createInstallationActivities(); let finish;
  const current = activities.run(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); activities.pause();
  await assert.rejects(activities.run(() => undefined), /pairing is changing/);
  await assert.rejects(activities.drain(5), /Kiosk is busy/);
  finish(); await current; await activities.drain();
  activities.resume(); assert.equal(await activities.run(() => 42), 42);
});

test("POSIX archives reject shared permissions and multiply linked state before moving files", { skip: process.platform === "win32" }, async t => {
  const { root, pinPath } = await fixture(t);
  const store = createUnpairingStore(root, { pinPath });
  await chmod(join(root, "slot-mappings.json"), 0o644);
  await assert.rejects(store.unpair(), /protected local-state recovery/);
  assert.equal((await readdir(root)).includes("reassociation"), false);
  await chmod(join(root, "slot-mappings.json"), 0o600);
  await link(join(root, "slot-mappings.json"), join(root, "duplicate.json"));
  await assert.rejects(store.unpair(), /protected local-state recovery/);
  assert.equal(await readFile(join(root, "pairing.json"), "utf8"), "synthetic-old-pairing");
});

test("scanner pause waits for the current scan to be durably queued", async () => {
  let finishCapture; const events = [];
  const scanner = createIdentityScanner({ captureIdentity: () => new Promise(resolve => { finishCapture = resolve; }), queue: { pending: async () => [], enqueue: async event => { events.push(event); return true; } }, loadPairing: async () => ({ pairingId: "synthetic-old" }), flushAttendance: async () => { throw new Error("offline"); }, onDisplay: async () => undefined, onCloud: () => undefined, delay: async () => undefined });
  const current = scanner.tick(); await Promise.resolve();
  const paused = scanner.pauseAndDrain();
  finishCapture({ status: "identified", memberId: "synthetic-member" });
  await Promise.all([current, paused]);
  assert.equal(events.length, 1); assert.equal(events[0].pairingId, "synthetic-old");
  await scanner.tick(); assert.equal(events.length, 1);
});

async function runtime(t, { pending = false } = {}) {
  const { root, pinPath } = await fixture(t);
  await createNetworkPinStore(pinPath).set("123456");
  const cloud = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/kiosk/pair") response.end(JSON.stringify({ kioskId: "synthetic-new-kiosk", pairingId: "synthetic-new-pairing", kioskToken: "synthetic-new-token", name: "New installation" }));
    else if (request.url === "/kiosk/roster") response.end(JSON.stringify({ members: [{ memberId: "synthetic-new-member", firstName: "New", lastName: "Member", rosterId: "synthetic-new-identity" }] }));
    else response.end(JSON.stringify({ settings: {} }));
  });
  await new Promise(resolve => cloud.listen(0, "127.0.0.1", resolve));
  t.after(() => { cloud.closeAllConnections(); cloud.close(); });
  const apiUrl = `http://127.0.0.1:${cloud.address().port}`;
  await writeFile(join(root, "pairing.json"), JSON.stringify({ apiUrl, kioskId: "synthetic-old-kiosk", pairingId: "synthetic-old-pairing", kioskToken: "synthetic-old-token", kioskName: "Old installation" }), { mode: 0o600 });
  await writeFile(join(root, "roster-cache.json"), JSON.stringify({ version: 1, members: [{ memberId: "synthetic-old-member" }] }), { mode: 0o600 });
  const queue = createFileQueue(join(root, "attendance-queue.json"));
  if (pending) await queue.enqueue({ eventId: "synthetic-pending", memberId: "synthetic-member", occurredAt: new Date().toISOString(), pairingId: "synthetic-old-pairing" });
  const env = { ...process.env, NODE_ENV: "test", LANCERLOGIN_SENSOR_PATH: "disabled" };
  for (const [key, name] of Object.entries({ CONFIG: "pairing.json", NETWORK_PIN: "network-pin.json", QUEUE: "attendance-queue.json", MAPPINGS: "slot-mappings.json", BRANDING: "branding.json", AUTHENTICATION: "authentication.json", CREDENTIAL_MAPPINGS: "credential-mappings.json", ROSTER_CACHE: "roster-cache.json", FINGERPRINT_SYNC: "fingerprint-sync", FINGERPRINT_VAULT: "fingerprint-vault", FINGERPRINT_RESET: "fingerprint-reset", FINGERPRINT_REVIEW: "fingerprint-review" })) env[`LANCERLOGIN_${key}`] = join(root, name);
  async function start() {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `import { server } from ${JSON.stringify(new URL("../apps/kiosk/src/service.mjs", import.meta.url).href)}; server.listen(0,"127.0.0.1",()=>console.log(server.address().port));`], { env, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Runtime startup timed out")), 5000); child.stdout.once("data", data => { clearTimeout(timer); resolve(Number(data.toString().trim())); }); child.once("exit", code => { clearTimeout(timer); reject(new Error(`Runtime exited before startup: ${code}`)); }); });
    const url = `http://127.0.0.1:${port}`;
    const request = (path, method = "GET", input, headers = {}) => fetch(url + path, { method, ...(input ? { body: JSON.stringify(input) } : {}), headers: { "content-type": "application/json", ...headers }, signal: AbortSignal.timeout(10000) });
    return { child, url, request };
  }
  return { root, apiUrl, start };
}

test("runtime unpair requires local authorization and confirmation, restarts, then pairs without old caches", { timeout: 20000 }, async t => {
  const { root, apiUrl, start } = await runtime(t);
  const old = await start();
  assert.equal((await old.request("/maintenance/unpair", "POST", { confirmation: "UNPAIR" })).status, 403);
  assert.equal((await old.request("/network/unlock", "POST", { pin: "999999" })).status, 401);
  assert.equal((await old.request("/network/unlock", "POST", { pin: "123456" })).status, 200);
  assert.equal((await old.request("/maintenance/unpair", "POST", { confirmation: "UNPAIR" }, { origin: "https://untrusted.example" })).status, 403);
  const status = await (await old.request("/maintenance/pairing")).json();
  assert.equal(status.installation, apiUrl); assert.equal(status.pendingEvents, 0);
  assert.equal(JSON.stringify(status).includes("synthetic-old-token"), false);
  assert.equal((await old.request("/maintenance/unpair", "POST", {})).status, 400);
  const exit = once(old.child, "exit");
  const responses = await Promise.all([old.request("/maintenance/unpair", "POST", { confirmation: "UNPAIR" }), old.request("/maintenance/unpair", "POST", { confirmation: "UNPAIR" })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const response = responses.find(response => response.status === 200);
  assert.equal(response.status, 200); assert.equal((await response.json()).readerTemplatesRetained, true);
  assert.equal((await exit)[0], 1);
  assert.deepEqual((await readdir(root)).sort(), ["network-pin.json", "reassociation"]);
  const fresh = await start();
  const health = await (await fresh.request("/health")).json();
  assert.equal(health.paired, false); assert.equal(health.setupReady, true); assert.equal(health.pendingEvents, 0);
  assert.equal((await fresh.request("/attendance", "POST", { memberId: "synthetic-member" })).status, 400);
  assert.equal((await fresh.request("/identity", "POST", { memberId: "synthetic-member" })).status, 400);
  assert.equal((await fresh.request("/maintenance/pairing")).status, 403);
  assert.equal((await fresh.request("/network/unlock", "POST", { pin: "123456" })).status, 200);
  const pairingKey = "LL1." + Buffer.from(JSON.stringify({ apiUrl, code: "SYNTHETIC", kioskName: "New installation" })).toString("base64url");
  const paired = await fresh.request("/pair", "POST", { pairingKey });
  assert.equal(paired.status, 201);
  assert.equal(JSON.parse(await readFile(join(root, "pairing.json"), "utf8")).pairingId, "synthetic-new-pairing");
  assert.deepEqual((await (await fresh.request("/mappings")).json()).mappings, {});
  assert.deepEqual((await (await fresh.request("/credential-mappings")).json()).mappings, []);
  const roster = await (await fresh.request("/maintenance/members")).json();
  assert.equal(roster.members[0].memberId, "synthetic-new-member");
});

test("runtime refuses to unpair with pending scans and leaves the pairing intact", { timeout: 15000 }, async t => {
  const { root, start } = await runtime(t, { pending: true }); const kiosk = await start();
  await kiosk.request("/network/unlock", "POST", { pin: "123456" });
  const response = await kiosk.request("/maintenance/unpair", "POST", { confirmation: "UNPAIR" });
  assert.equal(response.status, 409); assert.match((await response.json()).error, /scans are still pending/);
  assert.equal((await (await kiosk.request("/health")).json()).paired, true);
  assert.equal(JSON.parse(await readFile(join(root, "pairing.json"), "utf8")).pairingId, "synthetic-old-pairing");
  assert.equal((await readdir(root)).includes("reassociation"), false);
});

test("runtime starts fail-closed after interruption and requires local confirmation to finish", { timeout: 15000 }, async t => {
  const { root, start } = await runtime(t); let moves = 0;
  const store = createUnpairingStore(root, { pinPath: join(root, "network-pin.json"), move: async (source, target) => { if (++moves === 2) throw new Error("synthetic interruption"); await rename(source, target); } });
  await assert.rejects(store.unpair(), /protected local-state recovery/);
  const kiosk = await start();
  const health = await (await kiosk.request("/health")).json();
  assert.equal(health.paired, false); assert.equal(health.setupReady, false);
  for (const [path, method] of [["/pair", "POST"], ["/attendance", "POST"], ["/identity", "POST"], ["/mappings", "GET"], ["/fingerprint-sync", "PATCH"]]) assert.equal((await kiosk.request(path, method, method === "POST" || method === "PATCH" ? {} : undefined)).status, 409);
  assert.equal((await kiosk.request("/maintenance/unpair", "POST", { confirmation: "UNPAIR" })).status, 403);
  await kiosk.request("/network/unlock", "POST", { pin: "123456" });
  assert.equal((await (await kiosk.request("/maintenance/pairing")).json()).recoveryPending, true);
  const exit = once(kiosk.child, "exit");
  assert.equal((await kiosk.request("/maintenance/unpair", "POST", { confirmation: "UNPAIR" })).status, 200);
  assert.equal((await exit)[0], 1);
  const fresh = await start(); assert.equal((await (await fresh.request("/health")).json()).setupReady, true);
});
