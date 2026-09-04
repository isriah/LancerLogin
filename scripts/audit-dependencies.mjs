import { spawn } from "node:child_process";

const timeoutMs = 120_000;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; cannot run the required dependency audit.");
const child = spawn(process.execPath, [
  npmCli,
  "audit",
  "--package-lock-only",
  "--audit-level=high",
  "--fetch-timeout=110000",
  "--fetch-retries=0",
], { stdio: "inherit" });
let timedOut = false;

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Dependency audit exceeded ${timeoutMs / 1_000} seconds. The configured npm registry may be unavailable or unresponsive.`);
  child.kill();
}, timeoutMs);

child.once("error", (error) => {
  clearTimeout(timer);
  console.error(`Unable to start npm dependency audit: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    console.error("Dependency audit was terminated after its time limit; Verify remains failed.");
    process.exitCode = 1;
    return;
  }
  if (code !== 0) {
    console.error(`Dependency audit failed (exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}). Review the npm output above for registry or high-severity vulnerability details.`);
    process.exitCode = code ?? 1;
  }
});
