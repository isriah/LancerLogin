import { spawnSync } from "node:child_process";

const timeoutMs = 120_000;
const attemptTimeoutMs = 35_000;
const maxAttempts = 3;
const allowTransientDefer = process.argv.includes("--defer-transient-to-ci");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; cannot run the required dependency audit.");
const transientFailure = /audit endpoint returned an error|network timeout|fetch failed|E(?:AI_AGAIN|CONNRESET|TIMEDOUT|503)|\b(?:429|5\d\d)\b.*(?:too many requests|service unavailable|gateway|server error)/i;
const startedAt = Date.now();

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync(process.execPath, [
    npmCli,
    "audit",
    "--package-lock-only",
    "--audit-level=high",
    "--fetch-timeout=30000",
    "--fetch-retries=0",
  ], { encoding: "utf8", timeout: attemptTimeoutMs });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.status === 0) {
    process.stdout.write(output);
    break;
  }

  const timedOut = result.error?.code === "ETIMEDOUT";
  const retryable = timedOut || transientFailure.test(output);
  if (retryable && attempt < maxAttempts && Date.now() - startedAt + attemptTimeoutMs < timeoutMs) {
    console.warn(`Dependency audit attempt ${attempt} encountered a transient registry failure; retrying (${attempt + 1}/${maxAttempts}).`);
    continue;
  }

  process.stderr.write(output);
  if (timedOut) console.error(`Dependency audit attempt exceeded ${attemptTimeoutMs / 1_000} seconds.`);
  if (retryable && allowTransientDefer) {
    console.warn("Local dependency audit could not reach the advisory endpoint after bounded retries. Security verification is deferred to the required strict audit for this exact commit in GitHub Verify; do not tag until that job passes.");
    break;
  }
  console.error(`Dependency audit failed after ${attempt} attempt${attempt === 1 ? "" : "s"}. Review the npm output above for registry or high-severity vulnerability details.`);
  process.exitCode = result.status ?? 1;
  break;
}
