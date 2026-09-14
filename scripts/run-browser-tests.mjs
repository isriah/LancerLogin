import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

const workspace = process.cwd();
const seed = Number.parseInt(createHash("sha256").update(workspace).digest("hex").slice(0, 8), 16);
const portBase = 30_000 + (seed % 10_000) * 3;
const playwrightCli = join(workspace, "node_modules", "playwright", "cli.js");

const child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    LANCERLOGIN_BROWSER_PORT_BASE: process.env.LANCERLOGIN_BROWSER_PORT_BASE ?? String(portBase),
    PWTEST_CACHE_DIR: process.env.PWTEST_CACHE_DIR ?? join(workspace, "node_modules", ".cache", "playwright-transform"),
  },
});

child.once("error", (error) => {
  console.error(`Unable to start Playwright: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (code !== 0) {
    console.error(`Playwright failed (exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}).`);
    process.exitCode = code ?? 1;
  }
});
