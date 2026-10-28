import test from "node:test";
import assert from "node:assert/strict";
import { moduleFailureForStatus, moduleRefreshIntervalMs, nextModuleAccess, type ModuleNavigationResult } from "../apps/dashboard/src/module-access.ts";
import type { ModulePlatformSnapshot } from "../packages/shared/src/module-platform.ts";

const snapshot = { revision: 3, selectionCompleted: true, capabilities: [], modules: [] } as unknown as ModulePlatformSnapshot;
const newer = { ...snapshot, revision: 4 } as ModulePlatformSnapshot;
const failed = (reason: "unavailable" | "unverified" | "signed-out"): ModuleNavigationResult => ({ error: true, reason, receivedAt: 0 });

test("module read failures are classified by status", () => {
  assert.equal(moduleFailureForStatus(undefined), "unavailable");
  assert.equal(moduleFailureForStatus(429), "unavailable");
  assert.equal(moduleFailureForStatus(500), "unavailable");
  assert.equal(moduleFailureForStatus(503), "unavailable");
  assert.equal(moduleFailureForStatus(401), "signed-out");
  assert.equal(moduleFailureForStatus(403), "unverified");
  assert.equal(moduleFailureForStatus(400), "unverified");
});

test("a transient refresh failure keeps the last confirmed snapshot and marks it stale", () => {
  const kept = nextModuleAccess({ snapshot, stale: false }, failed("unavailable"));
  assert.equal(kept.snapshot, snapshot);
  assert.equal(kept.stale, true);
  assert.equal(kept.failure, undefined);
  const recovered = nextModuleAccess(kept, { snapshot: newer, receivedAt: 1 });
  assert.deepEqual(recovered, { snapshot: newer, stale: false });
});

test("the first load still fails closed when no snapshot was ever confirmed", () => {
  assert.deepEqual(nextModuleAccess({ stale: false }, failed("unavailable")), { failure: "unavailable", stale: false });
});

test("an unverifiable snapshot drops module access, and an expired session reports signed out", () => {
  assert.deepEqual(nextModuleAccess({ snapshot, stale: true }, failed("unverified")), { failure: "unverified", stale: false });
  assert.equal(nextModuleAccess({ snapshot, stale: false }, failed("signed-out")).failure, "signed-out");
});

test("background module refresh is no faster than every 30 seconds", () => {
  assert.ok(moduleRefreshIntervalMs >= 30_000);
});
