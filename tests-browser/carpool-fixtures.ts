// Carpool is a plugin: its browser specs run only when the dashboard is composed with it, for example with
// node scripts/run-browser-tests.mjs --compose-selection tests/fixtures/carpool.modules.json tests-browser/carpool-workflow.spec.ts --workers=1
import { test } from "@playwright/test";
import { bundledModuleRegistry, type ModulePlatformSnapshot } from "../packages/shared/src/module-platform.ts";
import { moduleSnapshot } from "./module-fixtures";

export const carpoolComposed = Boolean(bundledModuleRegistry.get("carpool"));
export const carpoolSkipReason = "The Carpool plugin is not composed into this dashboard build; run with --compose-selection tests/fixtures/carpool.modules.json";

/** Skip the calling spec file unless the Carpool plugin is composed. */
export function requireCarpoolPlugin() {
  test.skip(!carpoolComposed, carpoolSkipReason);
}

export function carpoolSnapshot(options: Parameters<typeof moduleSnapshot>[1] = {}): ModulePlatformSnapshot {
  return moduleSnapshot("carpool", options);
}
