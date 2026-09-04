import { defineConfig, devices } from "@playwright/test";

const portBase = Number(process.env.LANCERLOGIN_BROWSER_PORT_BASE ?? 43_173);
if (!Number.isInteger(portBase) || portBase < 1_024 || portBase > 65_532) {
  throw new Error("LANCERLOGIN_BROWSER_PORT_BASE must reserve three valid consecutive ports.");
}
const dashboardPort = portBase;
const mockApiPort = portBase + 1;
const kioskPort = portBase + 2;
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
const mockApiUrl = `http://127.0.0.1:${mockApiPort}`;
const kioskUrl = `http://127.0.0.1:${kioskPort}`;
process.env.LANCERLOGIN_KIOSK_BASE_URL = kioskUrl;

export default defineConfig({
  testDir: "./tests-browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: dashboardUrl, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: [
    { command: "node tests/fixtures/dashboard-preview-server.mjs", url: `${mockApiUrl}/setup/status`, env: { LANCERLOGIN_MOCK_PORT: String(mockApiPort) }, reuseExistingServer: false },
    { command: `npm --workspace @lancerlogin/dashboard run dev -- --host 127.0.0.1 --port ${dashboardPort} --strictPort`, url: dashboardUrl, env: { VITE_API_BASE_URL: mockApiUrl }, reuseExistingServer: false },
    { command: "node tests/fixtures/kiosk-preview-server.mjs", url: `${kioskUrl}/health`, env: { LANCERLOGIN_KIOSK_PREVIEW_PORT: String(kioskPort) }, reuseExistingServer: false },
  ],
});
