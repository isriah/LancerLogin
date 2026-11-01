import { defineConfig, devices } from "@playwright/test";

// Virtual Pi scenarios: the real kiosk service with fake hardware, paired to a local Worker (scripts/virtual-kiosk.mjs).
// The tests share one stack and one kiosk, so they run in order in one worker.
const portBase = Number(process.env.LANCERLOGIN_VIRTUAL_KIOSK_PORT_BASE ?? 43_300);
if (!Number.isInteger(portBase) || portBase < 1_024 || portBase > 65_500) throw new Error("LANCERLOGIN_VIRTUAL_KIOSK_PORT_BASE must be a valid port.");
process.env.LANCERLOGIN_VIRTUAL_KIOSK_PANEL = `http://127.0.0.1:${portBase}`;

export default defineConfig({
  testDir: "./tests-virtual-kiosk",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 300_000,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/virtual-kiosk.mjs --reset --port-base ${portBase} --state .provision/virtual-kiosk-tests`,
    url: `http://127.0.0.1:${portBase}/api/status`,
    timeout: 300_000,
    reuseExistingServer: false,
    // The kiosk services log through the virtual kiosk script; show them when a scenario fails in CI.
    stdout: "pipe",
  },
});
