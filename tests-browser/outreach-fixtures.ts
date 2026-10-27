// Outreach is Core's official plugin: its browser specs run only when the dashboard is composed with it, as every
// installation build is, for example with
// node scripts/run-browser-tests.mjs --compose-selection tests/fixtures/official.modules.json tests-browser/outreach-workflow.spec.ts --workers=1
import { test } from "@playwright/test";
import { bundledModuleRegistry } from "../packages/shared/src/module-platform.ts";

export const outreachComposed = Boolean(bundledModuleRegistry.get("hour-tracking"));
export const outreachSkipReason = "The official Outreach plugin is not composed into this dashboard build; run with --compose-selection tests/fixtures/official.modules.json";

/** Skip the calling spec file, or the calling test, unless the Outreach plugin is composed. */
export function requireOutreachPlugin() {
  test.skip(!outreachComposed, outreachSkipReason);
}
