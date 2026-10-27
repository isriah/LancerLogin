// Once-per-isolate module reconciliation: runs before the first request, never during update maintenance, once per
// database binding, and retries a failed attempt only after a backoff.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureModulesReconciled } from "../apps/api/src/module-catalog.ts";

/** A database whose catalog read either fails or reports an unconfigured installation, counting reads. */
function database(fail: boolean) {
  const db = {
    reads: 0,
    prepare() {
      const statement = {
        bind: () => statement,
        all: async () => { db.reads += 1; if (fail) throw new Error("D1 unavailable"); return { results: [] }; },
        first: async () => { db.reads += 1; return null; },
      };
      return statement;
    },
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
