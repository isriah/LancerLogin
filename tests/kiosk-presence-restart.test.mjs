import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPresenceRestartStore } from "../apps/kiosk/src/presence-restart.mjs";

const presence = { generation: 2, lost: false, pages: [
  { pageId: "attendance-page-1234", mode: "attendance", generation: 1, remainingMs: 12_000 },
  { pageId: "operator-page-123456", mode: "maintenance", generation: 2, remainingMs: 2_000 },
] };
async function fixture(run) {
  let elapsed = 0;
  const monotonic = mock.method(performance, "now", () => elapsed);
  const root = await mkdtemp(join(tmpdir(), "presence-restart-"));
  await chmod(root, 0o700);
  let clock = { bootId: "boot-one", elapsedMs: 20_000 };
  const path = join(root, "presence.json"), sample = async () => clock;
  const store = createPresenceRestartStore(path, { sample });
  try { await run({ root, path, store, sample, clock: next => { clock = next; }, elapsed: next => { elapsed = next; } }); }
  finally { monotonic.mock.restore(); await rm(root, { recursive: true, force: true }); }
}

test("slow asynchronous boot sampling cannot extend a checkpoint lease", () => fixture(async ({ path, elapsed }) => {
  let first = true;
  const store = createPresenceRestartStore(path, { sample: async () => {
    if (first) { await Promise.resolve(); elapsed(2500); first = false; }
    return { bootId: "boot-one", elapsedMs: 25_000 };
  } });
  await store.save(presence, "pairing-binding");
  const restored = await store.take("pairing-binding");
  assert.deepEqual(restored.pages.map(page => page.remainingMs), [9500, 0]);
}));

test("restore sampling latency cannot extend the returned remaining lease", () => fixture(async ({ store, path, elapsed }) => {
  await store.save(presence, "pairing-binding");
  const recovering = createPresenceRestartStore(path, { sample: async () => {
    await Promise.resolve(); elapsed(2500);
    return { bootId: "boot-one", elapsedMs: 20_000 };
  } });
  const restored = await recovering.take("pairing-binding");
  assert.deepEqual(restored.pages.map(page => page.remainingMs), [9500, -500]);
}));

test("restart checkpoint subtracts boot elapsed time and preserves expired operator entries", () => fixture(async ({ store, clock, path }) => {
  await store.save(presence, "pairing-binding");
  clock({ bootId: "boot-one", elapsedMs: 23_000 });
  assert.deepEqual(await store.take("pairing-binding"), { ...presence, pages: [{ ...presence.pages[0], remainingMs: 9_000 }, { ...presence.pages[1], remainingMs: -1_000 }] });
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(await store.take("pairing-binding"), undefined);
}));

test("only one store instance can consume a restart checkpoint", () => fixture(async ({ store, path, sample }) => {
  await store.save(presence, "pairing-binding");
  const results = await Promise.all([store.take("pairing-binding"), createPresenceRestartStore(path, { sample }).take("pairing-binding")]);
  assert.equal(results.filter(Boolean).length, 1);
}));

test("lost presence stays latched and unavailable boot evidence cannot restore", () => fixture(async ({ store, path }) => {
  const suspended = { ...presence, lost: true };
  await store.save(suspended, "pairing-binding");
  assert.deepEqual(await store.take("pairing-binding"), suspended);
  await store.save(presence, "pairing-binding");
  const unavailable = createPresenceRestartStore(path, { sample: async () => { throw Error("Boot evidence unavailable"); } });
  assert.equal(await unavailable.take("pairing-binding"), undefined);
  assert.equal(await store.take("pairing-binding"), undefined);
}));

test("changed pairing, boot identity, and backwards elapsed clocks fail closed and consume evidence", () => fixture(async ({ store, clock }) => {
  for (const [binding, bootId, elapsedMs] of [["other-binding", "boot-one", 20_000], ["pairing-binding", "boot-two", 20_001], ["pairing-binding", "boot-one", 19_999]]) {
    clock({ bootId: "boot-one", elapsedMs: 20_000 });
    await store.save(presence, "pairing-binding");
    clock({ bootId, elapsedMs });
    assert.equal(await store.take(binding), undefined);
    assert.equal(await store.take("pairing-binding"), undefined);
  }
}));

test("invalid snapshots and unexpected fields cannot become restart authority", () => fixture(async ({ store, path }) => {
  for (const invalid of [{ ...presence, pin: "not-authority" }, { ...presence, pages: [presence.pages[0], presence.pages[0]] }, { ...presence, pages: [{ ...presence.pages[0], remainingMs: 15_001 }] }, { ...presence, pages: [{ ...presence.pages[0], remainingMs: -1 }] }, { ...presence, pages: [{ ...presence.pages[0], generation: 3 }] }]) await assert.rejects(store.save(invalid, "pairing-binding"), /Invalid presence/);
  for (const content of ["{broken", "x".repeat(32_769), JSON.stringify({ version: 1 })]) {
    await writeFile(path, content, { mode: 0o600 });
    assert.equal(await store.take("pairing-binding"), undefined);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
}));

test("checkpoint permissions are private and unsafe permissions never restore", { skip: process.platform === "win32" }, () => fixture(async ({ store, path, root }) => {
  await store.save(presence, "pairing-binding");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await chmod(path, 0o644);
  assert.equal(await store.take("pairing-binding"), undefined);
  await chmod(root, 0o755);
  await assert.rejects(store.save(presence, "pairing-binding"), /Unsafe presence checkpoint directory/);
}));

test("checkpoint symlinks cannot overwrite or restore another file", async t => fixture(async ({ store, path, root }) => {
  const target = join(root, "target.json");
  await writeFile(target, "protected unrelated contents", { mode: 0o600 });
  try { await symlink(target, path, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Host does not permit symlink creation"); return; } throw error; }
  await assert.rejects(store.save(presence, "pairing-binding"), /Unsafe presence checkpoint file/);
  assert.equal(await store.take("pairing-binding"), undefined);
  assert.equal(await readFile(target, "utf8"), "protected unrelated contents");
}));
