import test from "node:test";
import assert from "node:assert/strict";
import { readModuleSnapshot } from "../apps/dashboard/src/module-client.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { defaultModuleSnapshot } from "../tests/fixtures/default-module-snapshot.mjs";

test("the browser preview default remains a complete registry-backed Attendance installation", () => {
  const snapshot = readModuleSnapshot(defaultModuleSnapshot);
  assert.deepEqual(snapshot.modules.map((module) => module.id), bundledModuleRegistry.modules.filter((module) => module.available).map((module) => module.id));
  assert.deepEqual(snapshot.modules.filter((module) => module.enabled).map((module) => module.id), ["attendance"]);
  assert.deepEqual(snapshot.capabilities, ["attendance.manage"]);
});
