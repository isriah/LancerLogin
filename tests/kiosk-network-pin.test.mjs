import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNetworkPinStore, networkPinBackupPath, validNetworkPinRecord } from "../apps/kiosk/src/network-pin.mjs";

// A damaged network settings PIN file must neither lock the kiosk out of its network settings nor let someone at the
// kiosk choose a new PIN. Every test uses a synthetic PIN in a temporary directory.
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "lancerlogin-network-pin-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const quiet = { log: () => undefined };
const pinStore = (path, options = {}) => createNetworkPinStore(path, { ...quiet, ...options });
const listing = async path => (await readdir(path)).sort();

async function savedPin(t) {
  const root = await directory(t), path = join(root, "network-pin.json");
  await pinStore(path).set("123456");
  return { root, path, backup: networkPinBackupPath(path), good: await readFile(path, "utf8") };
}

// The ways a PIN file can be found: a power cut during an older release's write (empty, truncated), and valid JSON that
// is not a PIN record. "null" used to read as "no PIN set", which let anyone at the kiosk choose a new one.
const damaged = good => ({
  empty: "",
  truncated: good.slice(0, Math.floor(good.length / 2)),
  "array": "[]\n",
  "empty object": "{}\n",
  "record without a hash": `${JSON.stringify({ ...JSON.parse(good), hash: undefined })}\n`,
  "a short hash": `${JSON.stringify({ ...JSON.parse(good), hash: "AAAA" })}\n`,
  "negative counter": `${JSON.stringify({ ...JSON.parse(good), failures: -1 })}\n`,
  "null": "null\n",
  "a number": "0\n",
});

test("set writes the PIN file and its backup copy, owner-only, and leaves no temporary file", async t => {
  const { root, path, backup, good } = await savedPin(t);
  assert.deepEqual(await listing(root), ["network-pin.json", "network-pin.json.backup"]);
  assert.equal(await readFile(backup, "utf8"), good);
  assert.ok(validNetworkPinRecord(JSON.parse(good)));
  assert.doesNotMatch(good, /123456/);
  if (process.platform !== "win32") for (const file of [path, backup]) assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("each unreadable PIN file is restored from the backup copy and the same PIN still unlocks", async t => {
  const { path, backup, good } = await savedPin(t);
  for (const [name, bytes] of Object.entries({ ...damaged(good), missing: undefined })) {
    if (bytes === undefined) await unlink(path); else await writeFile(path, bytes);
    const messages = [], store = pinStore(path, { now: () => Date.parse("2026-11-20T10:00:00Z"), log: message => messages.push(message) });
    const status = await store.status();
    assert.deepEqual(status, { configured: true, authorized: false, lockedUntil: null, recovery: { state: "restored", at: "2026-11-20T10:00:00.000Z" } }, name);
    assert.equal(await readFile(path, "utf8"), good, `${name}: the PIN file is rewritten from the backup`);
    assert.match(messages.join("\n"), /Restored it from .*network-pin\.json\.backup/, name);
    assert.equal((await store.verify("000000")).authorized, false, name);
    assert.equal((await store.verify("123456")).authorized, true, name);
    // Recovery is not repeated once the file is whole again; a new process reports nothing.
    assert.equal("recovery" in await pinStore(path).status(), false, name);
    assert.equal(await readFile(backup, "utf8"), good, name);
  }
});

test("a PIN file that cannot be read without a backup keeps network settings locked instead of reading as unset", async t => {
  const { path, backup, good } = await savedPin(t);
  for (const [name, bytes] of Object.entries(damaged(good))) {
    await rm(backup, { force: true }); await writeFile(path, bytes);
    const messages = [], store = pinStore(path, { now: () => Date.parse("2026-11-20T10:00:00Z"), log: message => messages.push(message) });
    const status = await store.status();
    assert.deepEqual(status, { configured: true, authorized: false, lockedUntil: null, recovery: { state: "unreadable", at: "2026-11-20T10:00:00.000Z" } }, name);
    assert.deepEqual(await store.verify("123456"), { authorized: false, lockedUntil: null, unreadable: true }, name);
    assert.equal((await store.status()).authorized, false, name);
    assert.match(messages.join("\n"), /cannot be read\. Network settings and maintenance stay locked/, name);
    // Nothing is written over the damaged file: it stays for diagnosis until an Admin resets the PIN.
    assert.equal(await readFile(path, "utf8"), bytes, name);
    await assert.rejects(readFile(backup), { code: "ENOENT" }, name);
  }
  // A damaged backup with no PIN file is unreadable too, never "no PIN".
  await unlink(path); await writeFile(backup, "{");
  assert.equal((await pinStore(path).status()).recovery.state, "unreadable");
});

test("the dashboard reset clears an unreadable PIN so a new one can be set", async t => {
  const { root, path, backup } = await savedPin(t);
  await writeFile(path, ""); await writeFile(backup, "[]");
  const store = pinStore(path);
  assert.equal((await store.status()).recovery.state, "unreadable");
  assert.deepEqual(await store.reset(), { configured: false });
  assert.deepEqual(await store.status(), { configured: false, authorized: false, lockedUntil: null });
  assert.deepEqual(await listing(root), []);
  await store.set("654321");
  assert.equal((await pinStore(path).verify("654321")).authorized, true);
});

test("a PIN saved by an earlier release gets its backup copy on first use", async t => {
  const { root, path, backup, good } = await savedPin(t);
  await unlink(backup);
  assert.deepEqual(await pinStore(path).status(), { configured: true, authorized: false, lockedUntil: null });
  assert.equal(await readFile(backup, "utf8"), good);
  // A damaged backup beside a good PIN file is replaced the same way.
  await writeFile(backup, "{\"version\":1");
  await pinStore(path).status();
  assert.equal(await readFile(backup, "utf8"), good);
  assert.deepEqual(await listing(root), ["network-pin.json", "network-pin.json.backup"]);
});

test("temporary files left by an interrupted write are removed and never read", async t => {
  const { root, path, good } = await savedPin(t);
  const leftovers = [`network-pin.json.4242.${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tmp`, `network-pin.json.backup.4242.${"f".repeat(8)}-ffff-ffff-ffff-${"f".repeat(12)}.tmp`];
  await writeFile(join(root, leftovers[0]), good.slice(0, 10));
  await writeFile(join(root, leftovers[1]), "");
  await writeFile(join(root, "unrelated.tmp"), "kept");
  const store = pinStore(path);
  assert.equal((await store.verify("123456")).authorized, true);
  assert.deepEqual(await listing(root), ["network-pin.json", "network-pin.json.backup", "unrelated.tmp"]);
});

test("a write interrupted at any step leaves the old or the new PIN record, never an unreadable one", async t => {
  const steps = ["write", "sync", "rename", "directory"];
  for (const file of ["backup", "pin"]) for (const step of steps) {
    const { root, path, good } = await savedPin(t);
    // Three wrong tries are on record before the interrupted fourth.
    for (let attempt = 0; attempt < 3; attempt++) await pinStore(path).verify("000000");
    const before = JSON.parse(await readFile(path, "utf8"));
    assert.equal(before.failures, 3);
    // A power cut: the directory as it was at that moment is all the next start sees. A temporary file cut short at
    // the write step is the worst case.
    const crash = await directory(t);
    const target = file === "backup" ? networkPinBackupPath(path) : path;
    const store = pinStore(path, { onStep: async (current, written) => {
      if (current !== step || written !== target) return;
      for (const name of await readdir(root)) {
        await copyFile(join(root, name), join(crash, name));
        if (step === "write" && name.endsWith(".tmp")) await truncate(join(crash, name), 7);
      }
      throw new Error("synthetic power cut");
    } });
    await assert.rejects(store.verify("000000"), /synthetic power cut/);
    const restarted = pinStore(join(crash, "network-pin.json"));
    const status = await restarted.status();
    assert.equal(status.configured, true, `${file} ${step}`);
    assert.notEqual(status.recovery?.state, "unreadable", `${file} ${step}`);
    const saved = JSON.parse(await readFile(join(crash, "network-pin.json"), "utf8"));
    assert.ok([3, 4].includes(saved.failures), `${file} ${step}: the counter is the old or the new value, not reset`);
    assert.equal(saved.hash, JSON.parse(good).hash);
    assert.deepEqual(await listing(crash), ["network-pin.json", "network-pin.json.backup"], `${file} ${step}: no temporary file is left`);
    assert.equal((await restarted.verify("123456")).authorized, true, `${file} ${step}`);
  }
});

test("an interrupted reset leaves the PIN set, and a completed one removes both copies", async t => {
  const { root, path } = await savedPin(t);
  // The backup is removed first, so a reset cut short after that still has the PIN, and the backup is rewritten.
  await unlink(networkPinBackupPath(path));
  assert.equal((await pinStore(path).status()).configured, true);
  assert.deepEqual(await listing(root), ["network-pin.json", "network-pin.json.backup"]);
  await pinStore(path).reset();
  assert.deepEqual(await listing(root), []);
  assert.deepEqual(await pinStore(path).status(), { configured: false, authorized: false, lockedUntil: null });
});
