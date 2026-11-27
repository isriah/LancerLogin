import { appendFileSync } from "node:fs";
import type { FullConfig } from "@playwright/test";
import { startVirtualKioskStack } from "../scripts/virtual-kiosk/test-stack.mjs";

// Starts the virtual kiosk stack once for every scenario and stops it after the last one. The start picks a free block
// of ports and retries once on a known start-up failure (scripts/virtual-kiosk/test-stack.mjs); scenarios themselves
// are never retried. The chosen ports reach the scenarios through the environment, which Playwright's workers inherit.
export default async function globalSetup(config: FullConfig) {
  const requestedBase = Number(config.metadata.virtualKioskPortBase);
  const stack = await startVirtualKioskStack({ requestedBase });
  process.env.LANCERLOGIN_VIRTUAL_KIOSK_PORT_BASE = String(stack.base);
  process.env.LANCERLOGIN_VIRTUAL_KIOSK_PANEL = stack.panelUrl;
  // A start that needed its retry still passes, but says so in the job summary, so a signature that keeps coming back
  // gets looked at instead of hiding in the log.
  if (stack.attempts > 1 && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Virtual kiosk start-up needed its one retry.** ${stack.failures.join(" ")} See "Virtual kiosk: known harness failures" in the testing guide.\n`);
  }
  return async () => { await stack.stop(); };
}
