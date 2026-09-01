import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests-browser",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:43173", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: [
    { command: "node tests/fixtures/dashboard-preview-server.mjs", url: "http://127.0.0.1:8791/setup/status", env: { LANCERLOGIN_MOCK_PORT: "8791" }, reuseExistingServer: !process.env.CI },
    { command: "npm --workspace @lancerlogin/dashboard run dev -- --host 127.0.0.1 --port 43173 --strictPort", url: "http://127.0.0.1:43173", env: { VITE_API_BASE_URL: "http://127.0.0.1:8791" }, reuseExistingServer: false },
  ],
});
