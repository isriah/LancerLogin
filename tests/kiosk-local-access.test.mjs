import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createHostAllowlist, createSetupCode } from "../apps/kiosk/src/local-access.mjs";
import { createNetworkPinStore } from "../apps/kiosk/src/network-pin.mjs";

test("Host allowlist accepts only names that address this kiosk on its own port", () => {
  const allowlist = createHostAllowlist({ port: () => 8788, hostname: () => "LancerLogin-Pi",
    interfaces: () => ({ wlan0: [{ family: "IPv4", address: "192.168.1.40" }, { family: "IPv6", address: "fe80::1%wlan0" }], lo: [{ family: "IPv4", address: "127.0.0.1" }] }) });
  for (const host of ["127.0.0.1:8788", "localhost:8788", "[::1]:8788", "lancerlogin-pi:8788", "LancerLogin-Pi.local:8788", "192.168.1.40:8788", "[fe80::1]:8788", "lancerlogin-pi.local.:8788"]) assert.equal(allowlist.allowed(host), true, host);
  // DNS rebinding sends the attacker's name; wrong ports, missing ports and look-alike names are refused.
  for (const host of [undefined, "", "evil.example:8788", "127.0.0.1", "127.0.0.1:8789", "localhost.evil.example:8788", "lancerlogin-pi.evil.example:8788", "192.168.1.41:8788", "127.0.0.1:8788@evil", "a".repeat(400)]) assert.equal(allowlist.allowed(host), false, String(host));
});

test("LAN setup code rotates after repeated wrong guesses and pauses further attempts", () => {
  let clock = 0, next = 0;
  const codes = ["111111", "222222", "333333"];
  const code = createSetupCode({ now: () => clock, attempts: 3, lockMs: 1000, generate: () => codes[next++] });
  assert.equal(code.current(), "111111");
  assert.deepEqual(code.verify("111 111"), { ok: true });
  assert.deepEqual(code.verify("000000"), { ok: false, locked: false });
  assert.deepEqual(code.verify(undefined), { ok: false, locked: false });
  assert.deepEqual(code.verify("123456"), { ok: false, locked: true });
  assert.equal(code.current(), "222222", "the code changes after the lockout");
  assert.deepEqual(code.verify("222222"), { ok: false, locked: true }, "even the new code waits for the pause");
  clock = 1000;
  assert.deepEqual(code.verify("222222"), { ok: true });
  code.rotate(); assert.equal(code.current(), "333333");
});

test("PIN lockout persists across restarts, backs off exponentially and resets on success", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-pin-lockout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "network-pin.json");
  let clock = 1_000_000;
  const store = () => createNetworkPinStore(path, { now: () => clock });
  await store().set("123456");
  const guess = async (pin, instance = store()) => instance.verify(pin);
  for (let attempt = 0; attempt < 4; attempt++) assert.equal((await guess("000000")).lockedUntil, null);
  // A restart between guesses does not reset the counter.
  const locked = await guess("000000");
  assert.equal(Date.parse(locked.lockedUntil), clock + 30_000);
  assert.equal((await guess("123456")).authorized, false, "even the right PIN waits");
  assert.ok((await store().status()).lockedUntil);
  clock += 30_000;
  for (let attempt = 0; attempt < 4; attempt++) await guess("000000");
  assert.equal(Date.parse((await guess("000000")).lockedUntil), clock + 60_000, "the second lockout doubles");
  clock += 60_000;
  assert.equal((await guess("123456")).authorized, true);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["hash", "salt", "version"], "success clears the counter and lockout");
  // Parallel guesses are serialized, so they cannot slip past the counter.
  const instance = store();
  const results = await Promise.all(Array.from({ length: 8 }, () => instance.verify("000000")));
  assert.equal(results.filter(result => result.lockedUntil).length, 4);
  // A wall clock corrected backwards cannot extend the lockout beyond one hour.
  clock -= 24 * 60 * 60_000;
  const status = await store().status();
  assert.ok(Date.parse(status.lockedUntil) - clock <= 60 * 60_000);
  await guess("000000");
  assert.ok(JSON.parse(await readFile(path, "utf8")).lockedUntil - clock <= 60 * 60_000);
});

test("the kiosk service refuses rebinding hosts, trims LAN health and requires the on-screen code for LAN pairing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lancerlogin-local-access-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lan = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && (entry.family === "IPv4" || entry.family === 4))?.address ?? "";
  const program = `
    import assert from "node:assert/strict";
    import { request as httpRequest } from "node:http";
    const lan = process.argv[2];
    const { server } = await import(process.argv[1]);
    await new Promise(resolve => server.listen(0, lan ? "0.0.0.0" : "127.0.0.1", resolve));
    const port = server.address().port;
    const call = (address, path, { method = "GET", host = address + ":" + port, body } = {}) => new Promise((resolve, reject) => {
      const request = httpRequest({ host: address, port, path, method, headers: { host, ...(body ? { "content-type": "application/json" } : {}) } }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
      });
      request.on("error", reject); request.end(body ? JSON.stringify(body) : undefined);
    });
    try {
      // DNS rebinding: loopback socket, attacker host name.
      assert.equal((await call("127.0.0.1", "/health", { host: "rebind.example:" + port })).status, 403);
      assert.equal((await call("127.0.0.1", "/network/pin", { method: "POST", host: "rebind.example:" + port, body: { pin: "123456" } })).status, 403);
      const local = await call("127.0.0.1", "/health");
      assert.equal(local.status, 200);
      assert.match(local.body.setupCode, /^\\d{6}$/);
      assert.ok("attendance" in local.body);
      if (lan) {
        const remote = await call(lan, "/health");
        assert.deepEqual(remote.body, { ok: true, service: "lancerlogin-kiosk", paired: false, setupReady: true, setupCodeRequired: true });
        assert.equal((await call(lan, "/pair", { method: "POST", body: { pairingKey: "LL1.invalid" } })).status, 403);
        // The right code is accepted (the synthetic key itself is then invalid).
        const accepted = await call(lan, "/pair", { method: "POST", body: { pairingKey: "LL1.invalid", setupCode: local.body.setupCode } });
        assert.equal(accepted.status, 400);
        for (let attempt = 0; attempt < 4; attempt++) assert.equal((await call(lan, "/pair", { method: "POST", body: { pairingKey: "x", setupCode: "999999" === local.body.setupCode ? "999998" : "999999" } })).status, 403);
        assert.equal((await call(lan, "/pair", { method: "POST", body: { pairingKey: "x", setupCode: "999999" === local.body.setupCode ? "999998" : "999999" } })).status, 429);
        assert.notEqual((await call("127.0.0.1", "/health")).body.setupCode, local.body.setupCode, "the code rotates after the lockout");
        assert.equal((await call(lan, "/network/pin", { method: "POST", body: { pin: "123456" } })).status, 403);
      }
      // Loopback pairing needs no code.
      assert.equal((await call("127.0.0.1", "/pair", { method: "POST", body: { pairingKey: "LL1.invalid" } })).status, 400);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `;
  const env = { ...process.env, NODE_ENV: "test", LANCERLOGIN_SENSOR_PATH: "disabled" };
  for (const [key, name] of Object.entries({ CONFIG: "pairing.json", NETWORK_PIN: "network-pin.json", QUEUE: "attendance-queue.json", MAPPINGS: "slot-mappings.json", BRANDING: "branding.json", AUTHENTICATION: "authentication.json", CREDENTIAL_MAPPINGS: "credential-mappings.json", ROSTER_CACHE: "roster-cache.json", FINGERPRINT_SYNC: "fingerprint-sync", FINGERPRINT_VAULT: "fingerprint-vault", FINGERPRINT_RESET: "fingerprint-reset", FINGERPRINT_REVIEW: "fingerprint-review" })) env[`LANCERLOGIN_${key}`] = join(directory, name);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, new URL("../apps/kiosk/src/service.mjs", import.meta.url).href, lan], { encoding: "utf8", timeout: 20_000, env });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  if (!lan) t.diagnostic("No non-loopback IPv4 interface; LAN assertions were skipped");
});
