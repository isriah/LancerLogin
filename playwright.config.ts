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
// The dashboard is a production build served by vite preview in CI and with `npm run test:browser -- --server build`,
// and the Vite dev server otherwise. The build runs as the server starts, so it bakes in this run's mock API address
// and includes any plugins the runner composed first (scripts/serve-dashboard-build.mjs).
const dashboardServer = process.env.LANCERLOGIN_BROWSER_SERVER || (process.env.CI ? "build" : "dev");
if (dashboardServer !== "build" && dashboardServer !== "dev") throw new Error("LANCERLOGIN_BROWSER_SERVER must be build or dev.");
const dashboardCommand = dashboardServer === "build"
  ? `node scripts/serve-dashboard-build.mjs --port ${dashboardPort}`
  : `npm --workspace @lancerlogin/dashboard run dev -- --host 127.0.0.1 --port ${dashboardPort} --strictPort`;

export default defineConfig({
  testDir: "./tests-browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  // CI also writes a JSON report: the job summary lists the tests that needed their retry (scripts/browser-test-summary.mjs).
  reporter: process.env.CI ? [["github"], ["json", { outputFile: "playwright-report/browser-results.json" }]] : "list",
  // Every spec runs in UTC with en-US formatting unless it pins its own, so results never depend on the host's zone.
  use: { baseURL: dashboardUrl, trace: "retain-on-failure", ...devices["Desktop Chrome"], timezoneId: "UTC", locale: "en-US" },
  webServer: [
    { command: "node tests/fixtures/dashboard-preview-server.mjs", url: `${mockApiUrl}/setup/status`, env: { LANCERLOGIN_MOCK_PORT: String(mockApiPort) }, reuseExistingServer: false },
    { command: dashboardCommand, url: dashboardUrl, env: { VITE_API_BASE_URL: mockApiUrl }, reuseExistingServer: false },
    { command: "node tests/fixtures/kiosk-preview-server.mjs", url: `${kioskUrl}/health`, env: { LANCERLOGIN_KIOSK_PREVIEW_PORT: String(kioskPort) }, reuseExistingServer: false },
  ],
});
