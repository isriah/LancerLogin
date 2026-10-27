import test from "node:test";
import assert from "node:assert/strict";
import { readModuleSnapshot } from "../apps/dashboard/src/module-client.ts";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";
import { defaultModuleSnapshot } from "../tests/fixtures/default-module-snapshot.mjs";

// The shapes the Worker reports for unavailable modules (apps/api/src/module-platform.ts readModulePlatformSnapshot).
function setupIncomplete(id: string) {
  const module = bundledModuleRegistry.get(id)!;
  return { id, label: module.label, description: module.description, contractVersion: module.contractVersion, enabled: false, phase: "disabled", generation: 0, dependencies: module.dependencies, permissions: [], effectiveCapabilities: [], workspaceReady: false, navigation: [], settings: [], setup: { ...module.setup, ready: false }, deletion: { disabledAt: null, deleteAfter: null, contentStillPresent: false, cleanupFailure: "Database setup for this module has not completed. LancerLogin retries automatically.", data: module.deletedData }, unavailable: "setup-incomplete" };
}
const removed = { id: "retired-plugin", label: "Retired plugin", description: "Code no longer installed", contractVersion: 1, enabled: false, phase: "retained", generation: 3, dependencies: [], permissions: [], effectiveCapabilities: [], workspaceReady: false, navigation: [], settings: [], setup: { version: 1, steps: [], ready: true }, deletion: { disabledAt: "2026-10-20T00:00:00.000Z", deleteAfter: "2026-10-27T00:00:00.000Z", contentStillPresent: true, cleanupFailure: null, data: ["Retired records"] }, unavailable: "removed" };
const withModules = (change: (modules: any[]) => any[]) => { const snapshot = structuredClone(defaultModuleSnapshot) as any; snapshot.modules = change(snapshot.modules); snapshot.capabilities = snapshot.modules.flatMap((module: any) => module.effectiveCapabilities); return snapshot; };

test("a plugin whose database setup is incomplete or whose code was removed never makes the workspace unverifiable", () => {
  const optional = "attendance";
  const snapshot = readModuleSnapshot(withModules((modules) => [...modules.map((module) => module.id === optional ? setupIncomplete(optional) : module), removed]));
  assert.equal(snapshot.modules.find((module) => module.id === optional)?.unavailable, "setup-incomplete");
  assert.equal(snapshot.modules.find((module) => module.id === "retired-plugin")?.unavailable, "removed");
  assert.deepEqual(snapshot.capabilities, []);
});

test("unavailable modules grant nothing and keep their lifecycle shape", () => {
  const optional = "attendance";
  const invalid: [string, any[]][] = [
    ["granted capabilities", [{ ...removed, effectiveCapabilities: ["retired.manage"] }]],
    ["workspace access", [{ ...removed, workspaceReady: true }]],
    ["navigation", [{ ...removed, navigation: [{ path: "/retired", label: "Retired" }] }]],
    ["removed but installed", [{ ...removed, id: optional }]],
    ["setup-incomplete but not installed", [{ ...setupIncomplete(optional), id: "not-installed" }]],
    ["setup-incomplete but enabled", [{ ...setupIncomplete(optional), enabled: true, phase: "enabled" }]],
    ["unknown kind", [{ ...removed, unavailable: "paused" }]],
    ["duplicate", [removed, removed]],
  ];
  for (const [name, extra] of invalid) {
    const replaced = extra.some((module) => module.id === optional);
    assert.throws(() => readModuleSnapshot(withModules((modules) => [...modules.filter((module) => !replaced || module.id !== optional), ...extra])), /could not be verified/, name);
  }
  // An installed module may not simply be missing.
  assert.throws(() => readModuleSnapshot(withModules((modules) => modules.filter((module) => module.id !== optional))), /could not be verified/);
});

test("the browser preview default remains a complete registry-backed Attendance installation", () => {
  const snapshot = readModuleSnapshot(defaultModuleSnapshot);
  assert.deepEqual(snapshot.modules.map((module) => module.id), bundledModuleRegistry.modules.filter((module) => module.available).map((module) => module.id));
  assert.deepEqual(snapshot.modules.filter((module) => module.enabled).map((module) => module.id), ["attendance"]);
  assert.deepEqual(snapshot.capabilities, ["attendance.manage"]);
});
