import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findShell, requireTool, toolSkip } from "./fixtures/host-tools.mjs";

// The installation workflow's own checks of the Cloudflare token and of the deployed installation. Both run the step's
// shell as the workflow ships it, against a curl stub, so no request leaves the machine.
const workflowPath = ".github/workflows/provision-template.yml";
const stepsOf = (workflow) => workflow.replace(/\r\n/g, "\n").split(/\n(?= {6}- )/).slice(1);
const provisionStep = async (name) => {
  const step = stepsOf(await readFile(workflowPath, "utf8")).find((entry) => entry.includes(`name: ${name}`));
  assert.ok(step, name);
  return step;
};
const runBlock = (step) => {
  const lines = step.split("\n"); const start = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  return lines.slice(start + 1).map((line) => line.slice(10)).join("\n");
};
const bash = findShell("bash");
const spawnScript = (root, script, values) => spawnSync(bash.path, [script], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, env: bash.env({ ...process.env, ...values }) });

test("a rejected Cloudflare token says it has probably expired or been deleted, and how to replace it", { skip: toolSkip(bash) }, async (t) => {
  requireTool(bash);
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-token-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Stub for Cloudflare's /tokens/verify: STATUS is the HTTP status, BODY the response (none when empty).
  const stub = [
    "curl() {",
    "  local out; while [ $# -gt 0 ]; do [ \"$1\" = --output ] && out=$2; shift; done",
    "  if [ -n \"$BODY\" ]; then printf '%s' \"$BODY\" > \"$out\"; fi",
    "  printf '%s' \"$STATUS\"",
    "  [ \"$STATUS\" != 000 ]",
    "}",
  ].join("\n");
  await writeFile(join(root, "verify.sh"), `set -eo pipefail\n${stub}\n${runBlock(await provisionStep("Verify the scoped token and selected Cloudflare account"))}\n`);
  const run = (status, body) => spawnScript(root, "verify.sh", { STATUS: String(status), BODY: body === undefined ? "" : JSON.stringify(body), CLOUDFLARE_API_TOKEN: "cfat_synthetic", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) });
  const setupLink = "https://isriah.github.io/LancerLogin/setup.html#cloudflare-token";
  const newToken = `create a new Account API token in the Cloudflare dashboard (Manage account > Account API tokens) with the four permissions listed at ${setupLink}, replace the production environment secret CLOUDFLARE_API_TOKEN with it, then run this workflow again.`;

  assert.equal(run(200, { success: true, result: { status: "active" } }).status, 0);
  // The run that prompted this message: HTTP 401 with Cloudflare code 1000, months after setup.
  const expired = run(401, { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] });
  assert.equal(expired.status, 1);
  assert.equal(expired.stdout.trim().split("\n").filter((line) => line.startsWith("::error")).length, 1);
  assert.ok(expired.stdout.includes(`::error title=cloudflare_token_rejected::Cloudflare did not accept CLOUDFLARE_API_TOKEN (HTTP 401; codes: 1000). The token has probably expired or been deleted, which is the usual cause when this installation was set up or last updated a while ago: ${newToken} If the token is new, check instead that CLOUDFLARE_ACCOUNT_ID names the account that owns it.`), expired.stdout);
  // A 401 without a readable body still gives the same advice.
  assert.match(run(401).stdout, /^::error title=cloudflare_token_rejected::Cloudflare did not accept CLOUDFLARE_API_TOKEN \(HTTP 401; codes: none\)\. The token has probably expired or been deleted/m);
  // Other refusals keep the account advice first.
  const refused = run(403, { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] });
  assert.equal(refused.status, 1);
  assert.ok(refused.stdout.includes(`::error title=cloudflare_token_rejected::Cloudflare refused CLOUDFLARE_API_TOKEN for CLOUDFLARE_ACCOUNT_ID (HTTP 403; codes: 9109): check that CLOUDFLARE_ACCOUNT_ID names the account that owns the Account API token (Manage account > Account API tokens in that account) and that the token is active. If the token has expired or been deleted, ${newToken}`), refused.stdout);
  // Cloudflare not answering is not blamed on the token, but the required token is still unverified, so the run stops.
  for (const status of [0, 429, 503]) {
    const unavailable = run(String(status).padStart(3, "0"));
    assert.equal(unavailable.status, 1, String(status));
    assert.match(unavailable.stdout, new RegExp(`^::error title=cloudflare_token_check_unavailable::Cloudflare did not answer the check of CLOUDFLARE_API_TOKEN \\(HTTP ${String(status).padStart(3, "0")}; codes: none\\), so the token could not be verified and nothing was changed: run this workflow again in a few minutes\\.$`, "m"));
  }
  // An answer that is not active names the status Cloudflare reported.
  const disabled = run(200, { success: true, result: { status: "expired" } });
  assert.equal(disabled.status, 1);
  assert.ok(disabled.stdout.includes(`::error title=account_token_invalid::Cloudflare reports CLOUDFLARE_API_TOKEN as expired, not active. An expired or disabled token cannot deploy: ${newToken}`), disabled.stdout);
  assert.match(run(200, { success: false }).stdout, /^::error title=account_token_invalid::Cloudflare did not report CLOUDFLARE_API_TOKEN as active\. /m);
  assert.match(run(200, { success: true, result: { status: "<script>" } }).stdout, /^::error title=account_token_invalid::Cloudflare did not report CLOUDFLARE_API_TOKEN as active\. /m);
});

test("the setup page section the token message links to lists the token's permissions", async () => {
  const setup = await readFile("docs-site/setup.html", "utf8");
  const section = setup.slice(setup.indexOf('<h2 id="cloudflare-token">'), setup.indexOf('<h2 id="account-id">'));
  for (const permission of ["Workers Scripts", "D1", "Pages", "Account Settings"]) assert.match(section, new RegExp(`<td>${permission}</td>`), permission);
});

const embeddedPolicySource = async () => runBlock(await provisionStep("Resolve the public release")).match(/<<'EOF'\n([\s\S]*?)\nEOF\n/)[1];
const healthStepName = "Verify that the installation answers on the new release";

test("the embedded policy accepts only the deployed release in the ready mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-deployed-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "release-policy.cjs"), await embeddedPolicySource());
  const { deployed } = createRequire(import.meta.url)(join(root, "release-policy.cjs"));
  const health = (overrides = {}) => ({ ok: true, service: "lancerlogin-api", mode: "ready", releaseVersion: "2.1.0-beta.11", modules: ["attendance"], deployment: null, ...overrides });
  // The shape every release since 2.0.0 returns, before and after the first Admin exists alike.
  assert.equal(deployed(health(), "v2.1.0-beta.11"), "ready");
  assert.equal(deployed(health({ releaseVersion: "2.0.0" }), "v2.1.0-beta.11"), "release:2.0.0");
  assert.equal(deployed(health({ releaseVersion: "development" }), "v2.1.0-beta.11"), "release:development");
  assert.equal(deployed(health({ releaseVersion: undefined }), "v2.1.0-beta.11"), "release:unknown");
  assert.equal(deployed(health({ releaseVersion: "2.1.0\n::error title=x::y" }), "v2.1.0-beta.11"), "release:unknown");
  assert.equal(deployed(health({ mode: "unconfigured" }), "v2.1.0-beta.11"), "mode:unconfigured");
  assert.equal(deployed(health({ ok: false }), "v2.1.0-beta.11"), "mode:not ok");
  assert.equal(deployed(health({ mode: "<b>" }), "v2.1.0-beta.11"), "mode:unknown");
  for (const answer of [null, [], "ok", { ok: true, mode: "ready", releaseVersion: "2.1.0-beta.11" }, health({ service: "other" })]) assert.equal(deployed(answer, "v2.1.0-beta.11"), "no_answer");
});

test("after deploying, the run waits for the Worker and the dashboard proxy to report the new release, at most two minutes", { skip: toolSkip(bash) }, async (t) => {
  requireTool(bash);
  const root = await mkdtemp(join(tmpdir(), "lancerlogin-health-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".provision"));
  await writeFile(join(root, "release-policy.cjs"), await embeddedPolicySource());
  // Stubs: curl answers each address from its own list (answers-api.txt, answers-pages.txt: one "<status> <body>" line
  // per request, the last line repeating), and sleep only advances the shell's clock.
  const stubs = [
    "curl() {",
    "  local out url key count line code; while [ $# -gt 0 ]; do [ \"$1\" = --output ] && out=$2; url=$1; shift; done",
    "  printf '%s\\n' \"$url\" >> curl-calls.txt",
    "  case \"$url\" in *-dashboard.pages.dev/api/health) key=pages ;; *) key=api ;; esac",
    "  printf 'x\\n' >> \"count-$key.txt\"; count=$(wc -l < \"count-$key.txt\")",
    "  line=$(sed -n \"$((count))p\" \"answers-$key.txt\"); [ -n \"$line\" ] || line=$(tail -n 1 \"answers-$key.txt\")",
    "  code=${line%% *}",
    "  if [ \"$code\" = 000 ]; then printf 000; return 7; fi",
    "  printf '%s' \"${line#* }\" > \"$out\"; printf '%s' \"$code\"",
    "}",
    "sleep() { printf '%s\\n' \"$1\" >> sleeps.txt; SECONDS=$((SECONDS + $1)); }",
  ].join("\n");
  await writeFile(join(root, "health.sh"), `set -eo pipefail\n${stubs}\n${runBlock(await provisionStep(healthStepName))}\n`);
  const answer = (code, body) => `${code} ${body === undefined ? "" : JSON.stringify(body)}`;
  const ready = (releaseVersion = "2.1.0-beta.11", mode = "ready") => answer(200, { ok: true, service: "lancerlogin-api", mode, releaseVersion, modules: ["attendance"], deployment: null });
  const run = async ({ api, pages = [ready()], operation = "upgrade", subdomain = "example-account" }) => {
    await writeFile(join(root, ".provision/workers-subdomain.txt"), subdomain);
    await writeFile(join(root, "answers-api.txt"), `${api.join("\n")}\n`);
    await writeFile(join(root, "answers-pages.txt"), `${pages.join("\n")}\n`);
    for (const name of ["curl-calls.txt", "sleeps.txt", "count-api.txt", "count-pages.txt", "summary.md"]) await writeFile(join(root, name), "");
    const result = spawnScript(root, "health.sh", { INPUT_OPERATION: operation, RELEASE_TAG: "v2.1.0-beta.11", INSTALLATION_SLUG: "example-club", RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      API_URL: "https://example-club-api.fallback-account.workers.dev", DASHBOARD_URL: "https://example-club-dashboard.pages.dev" });
    const text = async (name) => (await readFile(join(root, name), "utf8")).replace(/\r/g, "");
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: await text("curl-calls.txt"), sleeps: (await text("sleeps.txt")).split("\n").filter(Boolean), summary: await text("summary.md") };
  };
  const apiHealth = "https://example-club-api.example-account.workers.dev/health";
  const proxyHealth = "https://example-club-dashboard.pages.dev/api/health";
  const next = (rerun) => `The deploy steps themselves completed. In the Cloudflare dashboard, open Workers & Pages and check the Worker example-club-api and the Pages project example-club-dashboard (their latest deployment and logs), then run this workflow again with the operation ${rerun} and the same slug. See https://isriah.github.io/LancerLogin/troubleshooting.html#install.`;

  // Both answer as the new release at once: no wait, and the summary says so.
  const healthy = await run({ api: [ready()] });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(healthy.calls, `${apiHealth}\n${proxyHealth}\n`);
  assert.deepEqual(healthy.sleeps, []);
  assert.match(healthy.stdout, /The Worker API and the dashboard's \/api both answer as LancerLogin v2\.1\.0-beta\.11 in the ready mode\./);
  assert.match(healthy.summary, /### Health check passed\n\nThe Worker API \(`https:\/\/example-club-api\.example-account\.workers\.dev\/health`\) and the dashboard \(`https:\/\/example-club-dashboard\.pages\.dev\/api\/health`\) both answer as LancerLogin v2\.1\.0-beta\.11 in the ready mode\./);
  // A new installation (create) answers ready before its first Admin exists, so create passes on the same rule.
  assert.equal((await run({ api: [ready()], operation: "create" })).status, 0);
  // The old release answers for a few seconds, the proxy is not up yet: the run polls every five seconds and passes.
  const propagating = await run({ api: [ready("2.0.0"), answer("000"), ready("2.0.0"), ready()], pages: [answer(404, "Not found"), ready()] });
  assert.equal(propagating.status, 0, propagating.stderr);
  // Old, none, old, then new with the proxy still 404, then both new: four waits.
  assert.deepEqual(propagating.sleeps, ["5", "5", "5", "5"]);
  assert.doesNotMatch(propagating.stdout, /::error/);
  // Still the old release after two minutes: polls five seconds apart (24 waits at most; the requests' own time also
  // counts toward the two minutes), then a clear failure.
  const stale = await run({ api: [ready("2.0.0")] });
  assert.equal(stale.status, 1);
  assert.ok(stale.sleeps.length >= 2 && stale.sleeps.length <= 24, String(stale.sleeps.length));
  assert.ok(stale.sleeps.every((seconds) => seconds === "5"));
  assert.ok(stale.stdout.includes(`::error title=installation_health_release_mismatch::${apiHealth} still reports LancerLogin release 2.0.0 instead of 2.1.0-beta.11 after 120 seconds, so an older or different deployment is still the one answering, not the release this run deployed. ${next("upgrade")}`), stale.stdout);
  assert.equal(stale.summary, "");
  // The new release in a mode other than ready.
  const unconfigured = await run({ api: [ready(undefined, "unconfigured")], operation: "resume" });
  assert.equal(unconfigured.status, 1);
  assert.ok(unconfigured.stdout.includes(`::error title=installation_health_not_ready::${apiHealth} reports LancerLogin v2.1.0-beta.11, but in the mode unconfigured instead of ready after 120 seconds (unconfigured means the Worker has no D1 database binding). ${next("resume")}`), unconfigured.stdout);
  // No answer at all, from the Worker or only through the dashboard.
  const silent = await run({ api: [answer("000")], operation: "create" });
  assert.equal(silent.status, 1);
  assert.ok(silent.stdout.includes(`::error title=installation_health_no_answer::${apiHealth} did not answer with LancerLogin's health status within 120 seconds (last answer: HTTP 000). ${next("resume")}`), silent.stdout);
  const proxyDown = await run({ api: [ready()], pages: [answer(502, "Bad gateway")] });
  assert.equal(proxyDown.status, 1);
  assert.match(proxyDown.stdout, /^::error title=installation_health_no_answer::https:\/\/example-club-dashboard\.pages\.dev\/api\/health did not answer with LancerLogin's health status within 120 seconds \(last answer: HTTP 502\)\./m);
  // A 200 that is not LancerLogin's health answer counts as no answer.
  assert.match((await run({ api: [answer(200, "<html>")] })).stdout, /^::error title=installation_health_no_answer::.*\(last answer: HTTP 200\)/m);
  // An unusable workers.dev subdomain is never used; the deployment URL is.
  const fallback = await run({ api: [ready()], subdomain: "example.test/x" });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.calls, /^https:\/\/example-club-api\.fallback-account\.workers\.dev\/health\n/);
});

test("the health check is the run's last step, only reads, and runs for every operation", async () => {
  const steps = stepsOf(await readFile(workflowPath, "utf8"));
  const check = steps.findIndex((step) => step.includes(`name: ${healthStepName}`));
  assert.equal(check, steps.length - 1);
  assert.ok(check > steps.findIndex((step) => step.includes("name: Deploy Pages dashboard")));
  assert.doesNotMatch(steps[check], /\n {8}if:|continue-on-error|secrets\.|wrangler|-X |--request|--data/);
  assert.match(steps[check], /API_URL: \$\{\{ steps\.deploy-api\.outputs\.deployment-url \}\}/);
  assert.match(steps[check], /api_origin="https:\/\/\$INSTALLATION_SLUG-api\.\$subdomain\.workers\.dev"/);
  assert.match(steps[check], /node "\$RUNNER_TEMP\/release-policy\.cjs" deployed/);
  // The address matches the one the downgrade check reads the installed release from.
  const guard = steps.find((step) => step.includes("name: Check the update track and refuse a downgrade"));
  assert.match(guard, /api_origin="https:\/\/\$INSTALLATION_SLUG-api\.\$subdomain\.workers\.dev"/);
});
