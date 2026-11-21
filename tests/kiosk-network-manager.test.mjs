import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createNetworkManager, createSecureConnect, enterpriseRefusal, isEnterpriseSecurity, passwordPrompts } from "../apps/kiosk/src/network-manager.mjs";

// Joining Wi-Fi (apps/kiosk/src/network-manager.mjs). The join is the one the kiosk has always used: nmcli --ask,
// with the password typed at its prompt. nmcli itself only runs on a Pi, so a scripted stand-in plays its part.
const failure = "Could not join that Wi-Fi network. Check the password and try again.";
const scan = (lines) => async (args) => {
  if (args.includes("status")) return "wlan0:wifi:disconnected:--\n";
  if (args.includes("list")) return lines.join("\n") + "\n";
  return "";
};
/** A stand-in nmcli process. script(child) decides what it prints and when it exits. */
function fakeNmcli(script) {
  const spawned = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.typed = []; child.killed = false;
    child.stdin = { write: (text) => { child.typed.push(text); child.emit("typed", text); }, end: () => {} };
    child.kill = () => { if (!child.killed) { child.killed = true; setImmediate(() => child.emit("exit", null, "SIGTERM")); } };
    spawned.push({ command, args, child });
    setImmediate(() => script(child));
    return child;
  };
  return { spawnImpl, spawned };
}
/** Saved profiles as `nmcli -t -f UUID,TYPE,NAME connection show` lists them, and the deletions asked for. */
function profileStore(initial) {
  const profiles = [...initial], deleted = [];
  const run = async (args) => {
    if (args.includes("show")) return profiles.map(([uuid, name, type = "802-11-wireless"]) => `${uuid}:${type}:${name}`).join("\n") + "\n";
    if (args.includes("delete")) { deleted.push(args.at(-1)); return ""; }
    return "";
  };
  return { run, profiles, deleted };
}

test("password prompts are counted across chunks", () => {
  assert.deepEqual(passwordPrompts("Password: "), { count: 1, rest: " " });
  assert.deepEqual(passwordPrompts("Passw"), { count: 0, rest: "Passw" });
  assert.equal(passwordPrompts("Password (802-11-wireless-security.psk): \nError\nPassword (802-11-wireless-security.psk): ").count, 2);
  assert.equal(passwordPrompts("Error: No network with SSID 'x' found.\n").count, 0);
});

test("a join types the password at nmcli's first prompt exactly as entered, and never on the command line", async () => {
  const password = "  Shop 7 \"Q\"\\$z~!  ";
  const store = profileStore([]);
  const nmcli = fakeNmcli((child) => { child.once("typed", () => child.emit("exit", 0)); child.stdout.emit("data", "Passw"); child.stdout.emit("data", "ord: "); });
  await createSecureConnect({ run: store.run, spawnImpl: nmcli.spawnImpl })("Virtual Shop", password);
  assert.deepEqual(nmcli.spawned[0].args, ["--ask", "device", "wifi", "connect", "Virtual Shop"]);
  assert.deepEqual(nmcli.spawned[0].child.typed, [`${password}\n`]);
  assert.deepEqual(store.deleted, []);
});

test("a second password prompt ends the join at once and deletes only the profile that attempt created", async () => {
  const store = profileStore([["uuid-old-same-name", "Shop"], ["uuid-other", "Guest"]]);
  const nmcli = fakeNmcli((child) => {
    child.once("typed", () => { store.profiles.push(["uuid-new", "Shop"], ["uuid-new-wired", "Shop", "802-3-ethernet"]); child.stderr.emit("data", "Password (802-11-wireless-security.psk): "); });
    child.stdout.emit("data", "Password: ");
  });
  const started = Date.now();
  await assert.rejects(createSecureConnect({ run: store.run, spawnImpl: nmcli.spawnImpl, limitMs: 5_000 })("Shop", "wrong-password"), (error) => error.message === failure);
  assert.ok(Date.now() - started < 1_000, "it does not wait for the 30 second limit");
  assert.equal(nmcli.spawned[0].child.killed, true);
  assert.deepEqual(nmcli.spawned[0].child.typed, ["wrong-password\n"], "the password is not typed again");
  assert.deepEqual(store.deleted, ["uuid-new"], "a profile saved before the attempt is never deleted, even with the same name");
});

test("a join that times out or fails another way deletes nothing", async () => {
  const store = profileStore([["uuid-old", "Shop"]]);
  const slow = fakeNmcli((child) => { child.once("typed", () => store.profiles.push(["uuid-new", "Shop"])); child.stdout.emit("data", "Password: "); });
  await assert.rejects(createSecureConnect({ run: store.run, spawnImpl: slow.spawnImpl, limitMs: 40 })("Shop", "long-enough-password"), (error) => error.message === failure);
  const failed = fakeNmcli((child) => { child.stderr.emit("data", "Error: No network with SSID 'Shop' found.\n"); child.emit("exit", 10); });
  await assert.rejects(createSecureConnect({ run: store.run, spawnImpl: failed.spawnImpl })("Shop", "long-enough-password"), (error) => error.message === failure);
  assert.deepEqual(store.deleted, []);
});

test("when the saved profiles cannot be listed, a refused password still fails fast and nothing is deleted", async () => {
  const deleted = [];
  const run = async (args) => { if (args.includes("delete")) deleted.push(args); throw new Error("nmcli unavailable"); };
  const nmcli = fakeNmcli((child) => { child.once("typed", () => child.stdout.emit("data", "Password: ")); child.stdout.emit("data", "Password: "); });
  await assert.rejects(createSecureConnect({ run, spawnImpl: nmcli.spawnImpl })("Shop", "wrong-password"), (error) => error.message === failure);
  assert.deepEqual(deleted, []);
});

test("an 802.1X network is listed as unsupported and refused before nmcli is run", async () => {
  for (const [security, enterprise] of [["WPA2 802.1X", true], ["WPA1 WPA2 802.1X", true], ["WPA3 802.1X", true], ["WPA2", false], ["WPA1 WPA2", false], ["WPA3", false], ["WEP", false], ["--", false], ["", false]]) assert.equal(isEnterpriseSecurity(security), enterprise, security);
  const calls = [], joins = [];
  const manager = createNetworkManager({ run: async (args) => { calls.push(args); return scan(["*:Shop:80:WPA2", " :Campus:70:WPA2 802.1X", " :Guest:40:--"])(args); }, connectSecure: async (...join) => { joins.push(join); } });
  assert.deepEqual(await manager.wifi(), [
    { ssid: "Shop", signal: 80, secured: true, active: true }, { ssid: "Campus", signal: 70, secured: true, active: false, enterprise: true }, { ssid: "Guest", signal: 40, secured: false, active: false },
  ]);
  calls.length = 0;
  await assert.rejects(manager.connect("Campus", "some-password"), (error) => error.message === enterpriseRefusal);
  await assert.rejects(manager.connect("Campus"), (error) => error.message === enterpriseRefusal);
  assert.deepEqual([calls, joins], [[], []], "nmcli is not run for a network it could only prompt about");
});

test("a WPA password under 8 characters is refused before nmcli is run; everything else is joined as before", async () => {
  const calls = [], joins = [];
  const manager = createNetworkManager({ run: async (args) => { calls.push(args); return scan(["*:Shop:80:WPA2", " :Old:60:WEP", " :Guest:40:--"])(args); }, connectSecure: async (...join) => { joins.push(join); } });
  await manager.wifi(); calls.length = 0;
  await assert.rejects(manager.connect("Shop", "short"), /at least 8 characters/);
  assert.deepEqual([calls, joins], [[], []]);
  await manager.connect("Old", "abcde"); await manager.connect("Hidden", "abc"); await manager.connect("Shop", " 8 chars "); await manager.connect("Guest");
  assert.deepEqual(joins, [["Old", "abcde"], ["Hidden", "abc"], ["Shop", " 8 chars "]], "a WEP key, a network that was not scanned and spaces in a password are passed on unchanged");
  assert.deepEqual(calls.filter((args) => args.includes("connect")), [["device", "wifi", "connect", "Guest"]], "an open network is joined with the same command as before");
});
