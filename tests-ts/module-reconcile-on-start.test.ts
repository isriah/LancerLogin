// Once-per-isolate module reconciliation: runs before the first request, never during update maintenance, once per
// database binding, and retries a failed attempt only after a backoff.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureModulesReconciled } from "../apps/api/src/module-catalog.ts";

/**
 * A database whose catalog read fails, or that records every installed module, counting reads. `configured` says whether
 * first-Admin setup has created the installation; it can change between requests.
 */
function database(fail: boolean, configured = true) {
  const db = {
    reads: 0, batches: 0, configured,
    prepare() {
      const statement = {
        bind: () => statement,
        all: async () => { db.reads += 1; if (fail) throw new Error("D1 unavailable"); return { results: [] }; },
        first: async () => { db.reads += 1; return db.configured ? { configured: 1 } : null; },
      };
      return statement;
    },
    async batch() { db.batches += 1; return []; },
  };
  return db;
}

test("reconciliation runs once per binding and not again for later requests", async () => {
  const db = database(false), key = {};
  await ensureModulesReconciled(db as never, key, async () => false);
  const reads = db.reads;
  assert.ok(reads > 0);
  await ensureModulesReconciled(db as never, key, async () => false);
  assert.equal(db.reads, reads);
  // A different binding (another installation in the same process) reconciles independently.
  await ensureModulesReconciled(db as never, {}, async () => false);
  assert.ok(db.reads > reads);
});

test("concurrent first requests share one reconciliation", async () => {
  const db = database(false), key = {};
  await Promise.all([ensureModulesReconciled(db as never, key, async () => false), ensureModulesReconciled(db as never, key, async () => false)]);
  const single = database(false);
  await ensureModulesReconciled(single as never, {}, async () => false);
  assert.equal(db.reads, single.reads);
});

test("update maintenance defers reconciliation to the next request", async () => {
  const db = database(false), key = {};
  await ensureModulesReconciled(db as never, key, async () => true);
  assert.equal(db.reads, 0);
  await ensureModulesReconciled(db as never, key, async () => false);
  assert.ok(db.reads > 0);
});

test("a failed attempt never fails the request and retries only after a minute", async () => {
  const db = database(true), key = {};
  let clock = 1_000;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock);
  assert.equal(db.reads, 1);
  clock += 30_000;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock);
  assert.equal(db.reads, 1);
  clock += 31_000;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock);
  assert.equal(db.reads, 2);
});

test("before first-Admin setup the isolate keeps checking, and records modules on the first request after it", async () => {
  const db = database(false, false), key = {};
  // A request before setup (health, setup status) finds no installation: nothing is recorded and the isolate is not done.
  await ensureModulesReconciled(db as never, key, async () => false);
  assert.equal(db.batches, 0);
  const before = db.reads;
  await ensureModulesReconciled(db as never, key, async () => false);
  assert.ok(db.reads > before, "an unconfigured installation is checked again on the next request");
  // Once setup has created the installation, the next request records the installed modules, then the isolate is done.
  db.configured = true;
  await ensureModulesReconciled(db as never, key, async () => false);
  assert.equal(db.batches, 1);
  const after = db.reads;
  await ensureModulesReconciled(db as never, key, async () => false);
  assert.equal(db.reads, after);
});

test("a module migration failure is retried after a minute instead of waiting for the scheduled pass", async () => {
  const key = {}, db = {};
  let clock = 1_000, attempts = 0, failing = true;
  const reconcile = async () => { attempts += 1; return { changed: true, failures: failing ? [{ moduleId: "synthetic-notes", message: "Module migrations failed" }] : [] }; };
  await ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile);
  assert.equal(attempts, 1);
  clock += 30_000;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile);
  assert.equal(attempts, 1, "the failure backs off like a thrown error");
  clock += 31_000; failing = false;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile);
  assert.equal(attempts, 2, "the failed module is retried in this isolate");
  clock += 120_000;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile);
  assert.equal(attempts, 2, "a successful retry marks the isolate done");
});

test("a reconciliation that never settles (its request was cancelled) blocks later requests only up to the bound", async () => {
  const key = {}, db = {};
  let clock = 1_000, attempts = 0, settle = false;
  const reconcile = (): Promise<{ changed: boolean; failures: [] }> => { attempts += 1; return settle ? Promise.resolve({ changed: true, failures: [] }) : new Promise(() => {}); };
  const started = Date.now();
  await Promise.all([
    ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile, undefined, 20),
    ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile, undefined, 20),
  ]);
  assert.equal(attempts, 1, "concurrent requests still share the stuck attempt");
  assert.ok(Date.now() - started < 1_000, "neither request waits past the bound");
  await ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile, undefined, 20);
  assert.equal(attempts, 1, "an abandoned attempt backs off briefly instead of retrying on every request");
  clock += 10_000; settle = true;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile, undefined, 20);
  assert.equal(attempts, 2, "a later request starts a fresh reconciliation in its own context");
  clock += 120_000;
  await ensureModulesReconciled(db as never, key, async () => false, () => clock, reconcile, undefined, 20);
  assert.equal(attempts, 2, "the fresh attempt succeeded, so the isolate is done");
});

test("a normal reconciliation runs once and is handed to waitUntil so a disconnect cannot cancel it", async () => {
  const key = {}, db = {}, handed: Promise<unknown>[] = [];
  let attempts = 0;
  const reconcile = async () => { attempts += 1; return { changed: true, failures: [] }; };
  const waitUntil = (promise: Promise<unknown>) => { handed.push(promise); };
  await Promise.all([
    ensureModulesReconciled(db as never, key, async () => false, undefined, reconcile, waitUntil),
    ensureModulesReconciled(db as never, key, async () => false, undefined, reconcile, waitUntil),
  ]);
  await ensureModulesReconciled(db as never, key, async () => false, undefined, reconcile, waitUntil);
  assert.equal(attempts, 1);
  assert.equal(handed.length, 1, "only the request that starts the attempt registers it");
  await handed[0];
});
