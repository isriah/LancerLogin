import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireFingerprintStateLock } from "../apps/kiosk/src/fingerprint-state-lock.mjs";
import { createFingerprintResetStore } from "../apps/kiosk/src/fingerprint-reset-store.mjs";

const linux = { skip: process.platform !== "linux", timeout: 15000 };
const binding = { kioskId: "synthetic-kiosk", pairingId: "synthetic-pair" };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-fingerprint-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "reset.json");
}
async function holder(t, path) {
  const module = new URL("../apps/kiosk/src/fingerprint-state-lock.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireFingerprintStateLock } from ${JSON.stringify(module)};
    const lock = await acquireFingerprintStateLock(${JSON.stringify(path)});
    process.send("locked");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped; }
  });
  const ready = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(stderr || "Lock holder exited before acquiring"); })]);
  assert.equal(ready[0], "locked");
  return child;
}

test("Linux fingerprint lock excludes live processes and releases after SIGKILL without unlinking", linux, async t => {
  const path = `${await fixture(t)}.lock`;
  const child = await holder(t, path);
  const before = await lstat(path);
  await assert.rejects(acquireFingerprintStateLock(path), /busy/);
  assert.equal((await lstat(path)).ino, before.ino);
  const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
  const recovered = await acquireFingerprintStateLock(path);
  await assert.rejects(acquireFingerprintStateLock(path), /busy/);
  await recovered.close();
  const next = await acquireFingerprintStateLock(path); await next.close();
  assert.equal((await lstat(path)).ino, before.ino);
});

test("Linux first-use contention and interrupted directory creation preserve one lock owner", linux, async t => {
  const path = `${await fixture(t)}.lock`;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireFingerprintStateLock(path)));
  const owners = results.filter(result => result.status === "fulfilled");
  try { assert.equal(owners.length, 1); }
  finally { await Promise.all(owners.map(owner => owner.value.close())); }
  const inode = (await lstat(path)).ino;
  const recovered = await acquireFingerprintStateLock(path); await recovered.close();
  assert.equal((await lstat(path)).ino, inode);
  const interrupted = `${path}.interrupted`;
  await mkdir(interrupted, { mode: 0o700 });
  const resumed = await acquireFingerprintStateLock(interrupted); await resumed.close();
});

test("Linux crash recovery preserves pending reset and pairing validation", linux, async t => {
  const path = await fixture(t), store = createFingerprintResetStore(path, binding);
  await store.beginReset("synthetic-reset");
  const before = await readFile(path, "utf8"), child = await holder(t, `${path}.lock`);
  await assert.rejects(store.pendingReset(), /busy/);
  const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
  assert.equal(await store.pendingReset(), "synthetic-reset");
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(createFingerprintResetStore(path, { ...binding, pairingId: "wrong-pair" }).resetEpoch(), /protected local-state recovery/);
  await store.completeCommand("synthetic-reset");
  assert.equal(await store.pendingReset(), null);
  assert.equal(await store.resetEpoch(), "synthetic-reset");
  await writeFile(path, "{damaged", { mode: 0o600 });
  await assert.rejects(store.resetEpoch(), /protected local-state recovery/);
  assert.equal(await readFile(path, "utf8"), "{damaged");
});

test("Linux fingerprint locks reject legacy sentinels, unsafe permissions and links", linux, async t => {
  const path = `${await fixture(t)}.lock`;
  await writeFile(path, "", { mode: 0o600 });
  await assert.rejects(acquireFingerprintStateLock(path), /protected local recovery/);
  assert.equal(await readFile(path, "utf8"), "");
  await rm(path);
  const lock = await acquireFingerprintStateLock(path); await lock.close();
  await chmod(path, 0o755);
  await assert.rejects(acquireFingerprintStateLock(path), /protected local recovery/);
  await chmod(path, 0o700);
  const symbolic = `${path}.symlink`; await symlink(path, symbolic);
  await assert.rejects(acquireFingerprintStateLock(symbolic), /protected local recovery/);
  const unsafe = join(path, "..", "unsafe"); await mkdir(unsafe, { mode: 0o755 });
  await assert.rejects(acquireFingerprintStateLock(join(unsafe, "lock")), /protected local recovery/);
});
