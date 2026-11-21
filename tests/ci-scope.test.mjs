// quick-check: covers .github/workflows/**
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedFiles, classifyChange, docsSiteTest, scopeOutputs, selectDocsTests } from "../scripts/ci-scope.mjs";
import { isolatedGitEnv } from "../scripts/git-env.mjs";

test("only changes confined to docs/ and docs-site/ are documentation-only", () => {
  for (const files of [["docs-site/example-setup.html"], ["docs/EXAMPLE-GUIDE.md", "docs-site/assets/example.svg"], ["docs/releases/v0.0.0-example.md"]]) {
    assert.equal(classifyChange({ event: "push", files }).docs, true, files.join());
    assert.equal(classifyChange({ event: "pull_request", files }).docs, true, files.join());
  }
  for (const files of [
    ["docs-site/example-setup.html", "apps/api/src/index.ts"],
    [".github/workflows/docs.yml"],
    [".github/workflows/ci.yml", "docs/EXAMPLE-GUIDE.md"],
    ["scripts/ci-scope.mjs"],
    ["tests/docs-site.test.mjs", "docs-site/example-index.html"],
    ["README.md"],
    ["docs"],
    ["docs-sites/index.html"],
    ["package-lock.json", "docs/EXAMPLE-GUIDE.md"],
  ]) assert.equal(classifyChange({ event: "pull_request", files }).docs, false, files.join());
});

test("manual, scheduled, release, empty and unreadable changes always run complete scope", () => {
  const files = ["docs/EXAMPLE-GUIDE.md"];
  assert.equal(classifyChange({ event: "workflow_dispatch", files }).docs, false);
  assert.equal(classifyChange({ event: "schedule", files }).docs, false);
  assert.match(classifyChange({ event: "push", files, headMessage: "Release v2.0.1\n\nNotes" }).reason, /release commit/);
  assert.equal(classifyChange({ event: "push", files, headMessage: "Correct the kiosk wiring page" }).docs, true);
  assert.equal(classifyChange({ event: "push", files: [] }).docs, false);
  assert.equal(classifyChange({ event: "push", files: null }).docs, false);
});

test("documentation-only checks always include the docs-site suite and add tests that read a changed document", () => {
  const tests = new Map([
    [docsSiteTest, 'readFile(`docs-site/${page}`)'],
    ["tests/security.test.mjs", 'readFile("docs/EXAMPLE-RECOVERY.md")'],
    ["tests/foundation.test.mjs", 'readFile("docs/EXAMPLE-SECURITY.md")'],
    ["tests/kiosk-runtime.test.mjs", 'readFile("docs/EXAMPLE-GUIDE.md")'],
  ]);
  assert.deepEqual(selectDocsTests(["docs-site/example-setup.html"], tests), { tests: [docsSiteTest], install: false });
  assert.deepEqual(selectDocsTests(["docs/EXAMPLE-RECOVERY.md", "docs-site/example-index.html"], tests), { tests: [docsSiteTest, "tests/security.test.mjs"], install: true });
  // Device-only kiosk suites are left to the complete gate.
  assert.deepEqual(selectDocsTests(["docs/EXAMPLE-GUIDE.md"], tests).tests, [docsSiteTest]);
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
  const env = isolatedGitEnv(process.env, { GIT_AUTHOR_NAME: "Test Maintainer", GIT_AUTHOR_EMAIL: "maintainer@example.test", GIT_COMMITTER_NAME: "Test Maintainer", GIT_COMMITTER_EMAIL: "maintainer@example.test" });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = (message) => { git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  write("apps/api/src/index.ts", "export {};\n");
  write("docs/EXAMPLE-GUIDE.md", "# Kiosk\n");
  write("docs-site/example-index.html", "<h1>Docs</h1>\n");
  write("tests/docs-site.test.mjs", "// docs-site/\n");
  write("tests/security.test.mjs", 'readFile("docs/EXAMPLE-GUIDE.md")\n');
  write(".github/workflows/ci.yml", "name: Verify\n");
  const base = commit("Initial");
  return { root, git, write, commit, base, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("pushes and pull requests read their changed files from git", () => {
  const repo = repository();
  try {
    const { root, write, commit, base, git } = repo;
    write("docs-site/example-index.html", "<h1>Corrected docs</h1>\n");
    const docsOnly = commit("Correct the docs home page");
    assert.deepEqual(scopeOutputs({ event: "push", base, head: docsOnly }, root), { docs: true, reason: "1 documentation file(s) changed", tests: [docsSiteTest], install: false });

    write("docs/EXAMPLE-GUIDE.md", "# Kiosk wiring\n");
    const kioskDoc = commit("Correct the kiosk guide");
    assert.deepEqual(scopeOutputs({ event: "push", base: docsOnly, head: kioskDoc }, root).tests, [docsSiteTest, "tests/security.test.mjs"]);

    write("apps/api/src/index.ts", "export const changed = true;\n");
    const mixed = commit("Change the API and docs");
    assert.equal(scopeOutputs({ event: "push", base, head: mixed }, root).docs, false);

    write(".github/workflows/ci.yml", "name: Verify changed\n");
    const workflow = commit("Change the workflow");
    assert.equal(scopeOutputs({ event: "push", base: mixed, head: workflow }, root).docs, false);

    // Moving an application file into docs/ still names its old path.
    renameSync(join(root, "apps/api/src/index.ts"), join(root, "docs/index.ts"));
    const moved = commit("Move a source file");
    assert.deepEqual(changedFiles({ event: "push", base: workflow, head: moved, root }).sort(), ["apps/api/src/index.ts", "docs/index.ts"]);
    assert.equal(scopeOutputs({ event: "push", base: workflow, head: moved }, root).docs, false);

    // A pull request is compared with its merge base: application commits on the base branch do not count against it.
    git("checkout", "-q", "-b", "docs-fix", moved);
    write("docs/EXAMPLE-GUIDE.md", "# Kiosk wiring, corrected\n");
    const branchHead = commit("Correct the kiosk guide again");
    git("checkout", "-q", "main");
    write("apps/api/src/other.ts", "export {};\n");
    const advancedBase = commit("Base branch application change");
    assert.equal(scopeOutputs({ event: "pull_request", base: advancedBase, head: branchHead }, root).docs, true);
    assert.equal(scopeOutputs({ event: "push", base: advancedBase, head: branchHead }, root).docs, false);

    // New branches, unknown commits and release commits run the usual scope.
    assert.equal(scopeOutputs({ event: "push", base: "0000000000000000000000000000000000000000", head: docsOnly }, root).reason, "changed files could not be determined");
    assert.equal(scopeOutputs({ event: "push", base: "1111111111111111111111111111111111111111", head: docsOnly }, root).docs, false);
    assert.equal(scopeOutputs({ event: "push", base, head: docsOnly, "head-message": "Release v2.0.1" }, root).docs, false);
    assert.equal(scopeOutputs({ event: "workflow_dispatch", base, head: docsOnly }, root).docs, false);
  } finally { repo.cleanup(); }
});

test("Verify keeps its required jobs and runs only documentation checks for a documentation-only change", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
  const verify = ci.match(/\n  verify:\n([\s\S]*?)\n  [a-z-]+:\n/)?.[1];
  assert.ok(verify);
  // Scope is selected before the install so a documentation-only change can skip it.
  assert.ok(verify.indexOf("name: Select verification scope") < verify.indexOf("run: npm ci --no-audit"));
  assert.match(verify, /node scripts\/ci-scope\.mjs --event "\$GITHUB_EVENT_NAME" --base "\$docs_base" --head "\$HEAD_SHA" --head-message "\$HEAD_COMMIT_MESSAGE"/);
  assert.match(verify, /run: npm ci --no-audit\n\s+if: steps\.verification-scope\.outputs\.docs != 'true' \|\| steps\.verification-scope\.outputs\.docs-install == 'true'/);
  assert.match(verify, /installer runs\n\s+if: steps\.verification-scope\.outputs\.docs != 'true'\n/);
  assert.match(verify, /name: Run documentation-only verification\n\s+if: steps\.verification-scope\.outputs\.docs == 'true'[\s\S]*node --test "\$\{docs_tests\[@\]\}"/);
  for (const command of ["npm run verify:dev", "npm run verify:kiosk"]) {
    const step = verify.split("      - ").find((chunk) => chunk.includes(command));
    assert.match(step, /if: steps\.verification-scope\.outputs\.docs != 'true' && /, command);
  }
  // Complete verification (dispatch) never consults the documentation scope.
  assert.match(verify, /docs=false\n\s+if \[\[ "\$full" != "true" \]\]; then/);
  assert.match(verify, /"\$GITHUB_EVENT_NAME" == "workflow_dispatch" \]\]; then\n\s+full=true/);
});

// The private workflow that runs the virtual kiosk scenarios on pull requests that touch kiosk-facing code
// (.github/workflows/virtual-kiosk-pr.yml). It is excluded from public exports, so this checks it only where it exists.
const virtualKioskWorkflow = ".github/workflows/virtual-kiosk-pr.yml";
const virtualKioskPaths = [
  "apps/kiosk/**",
  "apps/dashboard/src/web-kiosk/**",
  "apps/dashboard/src/kiosks-page.tsx",
  "apps/api/src/index.ts",
  "apps/api/src/attendance-lifecycle.ts",
  "apps/api/src/discord-kiosk-codes.ts",
  "apps/api/src/fingerprint-*.ts",
  "apps/api/src/kiosk-*.ts",
  "apps/api/src/member-pins.ts",
  "apps/api/src/pairing-service.mjs",
  "apps/api/src/scan-*.ts",
  "packages/shared/src/member-lookup.mjs",
  "packages/shared/src/pairing-code.mjs",
  "packages/shared/src/password-key.mjs",
  "packages/shared/src/release-policy.mjs",
  "scripts/virtual-kiosk.mjs",
  "scripts/virtual-kiosk/**",
  "tests-virtual-kiosk/**",
  "playwright.virtual-kiosk.config.ts",
  "package-lock.json",
  virtualKioskWorkflow,
];
// GitHub's path filter for the patterns used here: * stays inside one folder, ** crosses folders.
const pathFilter = (pattern) => new RegExp(`^${pattern.split("**").map((part) => part.split("*").map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
const startsVirtualKiosk = (files, patterns = virtualKioskPaths) => files.some((file) => patterns.some((pattern) => pathFilter(pattern).test(file)));

test("the virtual kiosk scenarios run on private pull requests that touch kiosk-facing paths, and only those", { skip: !existsSync(virtualKioskWorkflow) && "public export" }, () => {
  const workflow = readFileSync(virtualKioskWorkflow, "utf8").replace(/\r\n/g, "\n");
  // Pull requests filtered by path, plus a manual run. No pushes, so a merge does not run it again.
  const triggers = workflow.match(/\non:\n([\s\S]*?)\npermissions:\n/)?.[1];
  assert.ok(triggers);
  assert.deepEqual(triggers.split("\n").filter((line) => /^  \S/.test(line)), ["  pull_request:", "  workflow_dispatch:"]);
  const paths = triggers.match(/^  pull_request:\n    paths:\n((?:      - .+\n?)+)/m)?.[1].trim().split("\n").map((line) => line.replace(/^\s*- /, ""));
  assert.deepEqual(paths, virtualKioskPaths);
  assert.doesNotMatch(triggers, /paths-ignore|branches/);

  // Every pattern still names something in the repository, so a renamed file cannot quietly leave the filter.
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const pattern of paths) assert.ok(tracked.some((file) => pathFilter(pattern).test(file)), `${pattern} matches no tracked file`);
  // Every file the harness and the scenarios import from the applications is in the filter.
  const sources = tracked.filter((file) => /^(?:scripts\/virtual-kiosk(?:\.mjs|\/.+\.mjs)|tests-virtual-kiosk\/.+\.ts)$/.test(file));
  assert.ok(sources.length > 5);
  for (const source of sources) {
    for (const [, specifier] of readFileSync(source, "utf8").matchAll(/from "((?:\.\.\/)+(?:apps|packages)\/[^"]+)"/g)) {
      const imported = join(dirname(source), specifier).replaceAll("\\", "/");
      assert.ok(startsVirtualKiosk([imported], paths), `${source} imports ${imported}, which is not in the path filter`);
    }
  }

  for (const files of [
    ["apps/kiosk/src/service.mjs"], ["apps/kiosk/systemd/lancerlogin-kiosk.service"], ["apps/dashboard/src/web-kiosk/member-pin.ts"], ["apps/dashboard/src/kiosks-page.tsx"],
    ["apps/api/src/index.ts"], ["apps/api/src/member-pins.ts"], ["apps/api/src/discord-kiosk-codes.ts"], ["apps/api/src/scan-refusal.ts"], ["apps/api/src/kiosk-poll.ts"],
    ["scripts/virtual-kiosk.mjs"], ["scripts/virtual-kiosk/fakes.mjs"], ["tests-virtual-kiosk/pi-discord-code.spec.ts"], ["playwright.virtual-kiosk.config.ts"],
    ["docs/EXAMPLE-GUIDE.md", "apps/kiosk/package.json"], [virtualKioskWorkflow],
  ]) assert.equal(startsVirtualKiosk(files, paths), true, files.join());
  for (const files of [
    ["apps/dashboard/src/reports-page.tsx"], ["apps/dashboard/src/styles.css"], ["apps/api/src/report-builder.ts"], ["apps/api/src/web-updates.ts"], ["apps/api/src/kiosk/nested.ts"],
    ["docs/EXAMPLE-GUIDE.md"], ["private/WORKFLOW.md"], ["tests/kiosk-discord-code.test.mjs"], ["tests-browser/kiosk-pins-admin.spec.ts"], ["scripts/check-quick.mjs"],
    [".github/workflows/quick-check.yml"], [".github/workflows/ci.yml"], ["playwright.config.ts"], ["package.json"],
  ]) assert.equal(startsVirtualKiosk(files, paths), false, files.join());

  // One private-only job, cancelled when the pull request is pushed again.
  const jobs = workflow.split(/^jobs:\n/m)[1];
  assert.deepEqual(jobs.match(/^  [a-z-]+:$/gm), ["  virtual-kiosk-pr:"]);
  assert.match(jobs, /^    if: github\.event\.repository\.private && github\.repository == '[\w.-]+\/[\w.-]+'$/m);
  assert.match(workflow, /concurrency:\n  group: virtual-kiosk-pr-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n  cancel-in-progress: true\n/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /secrets\./);

  // It runs the scenarios the way Verify's release gate does: the same steps and the same time limits.
  const ci = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
  const gate = ci.match(/\n  virtual-kiosk-browser:\n([\s\S]*?)\n  [a-z-]+:\n/)?.[1];
  assert.ok(gate);
  const fromRunner = (job) => job.slice(job.indexOf("    runs-on:"));
  assert.match(fromRunner(gate), /timeout-minutes: 40\n    steps:\n[\s\S]*timeout-minutes: 25\n        run: npm run test:kiosk-virtual\n/);
  assert.equal(fromRunner(jobs).trimEnd(), fromRunner(gate).trimEnd());
});

// The private workflow that runs every browser spec on main once a night (.github/workflows/nightly-browser.yml). It is
// excluded from public exports, so this checks it only where it exists.
const nightlyBrowserWorkflow = ".github/workflows/nightly-browser.yml";
const jobsOf = (workflow) => Object.fromEntries(workflow.split(/^jobs:\n/m)[1].split(/^(?=  [a-z0-9-]+:\n)/m)
  .filter((chunk) => /^  [a-z0-9-]+:\n/.test(chunk)).map((chunk) => [chunk.match(/^  ([a-z0-9-]+):/)[1], chunk]));

test("the nightly browser run repeats Verify's browser shards on main, privately, when main has moved", { skip: !existsSync(nightlyBrowserWorkflow) && "public export" }, () => {
  const workflow = readFileSync(nightlyBrowserWorkflow, "utf8").replace(/\r\n/g, "\n");
  // A nightly schedule and a manual run. Pull requests and pushes keep Quick check as their only check.
  const triggers = workflow.match(/\non:\n([\s\S]*?)\npermissions:\n/)?.[1];
  assert.ok(triggers);
  assert.deepEqual(triggers.split("\n").filter((line) => /^  \S/.test(line)), ["  schedule:", "  workflow_dispatch:"]);
  assert.match(triggers, /^    - cron: "\d{1,2} \d{1,2} \* \* \*"$/m);
  // Read-only, no new secrets, and a run that is still going finishes before the next one starts.
  assert.match(workflow, /^permissions:\n  contents: read\nconcurrency:\n  group: nightly-browser-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/m);
  assert.deepEqual([...new Set(workflow.match(/secrets\.\w+/g))], ["secrets.LANCERLOGIN_PLUGIN_TOKEN"]);
  assert.match(workflow, /^env:\n(?: {2}#[^\n]*\n)* {2}LANCERLOGIN_PLUGIN_FREE_BUILD: "1"$/m);

  const jobs = jobsOf(workflow);
  assert.deepEqual(Object.keys(jobs), ["changes", "core-browser-shard", "plugin-browser-shard", "integration-browser-shard", "passed"]);
  // Only the private repository runs it; every other job needs that one.
  assert.match(jobs.changes, /^    if: github\.event\.repository\.private && github\.repository == '[\w.-]+\/[\w.-]+'$/m);
  // A scheduled run skips the browsers when this commit already passed; a passing run on main leaves that marker.
  const restore = jobs.changes.match(/uses: actions\/cache\/restore@v4\n\s+with:\n\s+path: (.+)\n\s+key: (.+)\n\s+lookup-only: true/);
  assert.ok(restore);
  assert.match(jobs.changes, /if: github\.event_name == 'schedule'\n\s+uses: actions\/cache\/restore@v4/);
  assert.match(jobs.changes, /"\$GITHUB_EVENT_NAME" == "schedule" && "\$PASSED" == "true"[\s\S]*run=false[\s\S]*else[\s\S]*run=true/);
  assert.match(jobs.passed, /^    needs: \[core-browser-shard, plugin-browser-shard, integration-browser-shard\]\n    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.ok(jobs.passed.includes(`uses: actions/cache/save@v4\n        with:\n          path: ${restore[1]}\n          key: ${restore[2]}\n`));
  assert.equal(restore[2], "nightly-browser-passed-${{ github.sha }}");

  // Each shard job runs Verify's commands with Verify's matrix, environment and time limits, and keeps the traces of a failure.
  const verify = jobsOf(readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n"));
  const same = (job) => job.match(/^ {4}name: .+$|^ {4}timeout-minutes: .+$|^ {8}shard: .+$|^ {6,8}(?:- )?run: .+$|^ {8}timeout-minutes: .+$|^ {10}LANCERLOGIN_\w+: .+$/gm);
  for (const name of ["core-browser-shard", "plugin-browser-shard", "integration-browser-shard"]) {
    const nightly = jobs[name];
    assert.ok(verify[name], name);
    assert.match(nightly, /^    needs: changes\n    if: needs\.changes\.outputs\.run == 'true'$/m, name);
    assert.deepEqual(same(nightly), same(verify[name]), name);
    assert.ok(same(nightly).some((line) => line.includes("npm run test:browser -- --group ")), name);
    const group = name.replace("-browser-shard", "");
    assert.ok(nightly.includes(`if: \${{ failure() && steps.browser-specs.outcome == 'failure' }}\n        uses: actions/upload-artifact@v4\n        with:\n          name: browser-failure-${group}-\${{ matrix.shard }}\n          path: |\n            test-results/\n            playwright-report/\n`), name);
    assert.doesNotMatch(nightly, /continue-on-error|--grep|--project|--shard=/, name);
  }
  // The dev server smoke runs after the build shard's traces are kept, since Playwright clears test-results/ on start.
  const core = jobs["core-browser-shard"];
  assert.ok(core.indexOf("name: browser-failure-core-${{ matrix.shard }}\n") < core.indexOf("--server dev"));
  assert.match(core, /if: \$\{\{ failure\(\) && steps\.dev-server-smoke\.outcome == 'failure' \}\}\n\s+uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: browser-failure-core-\$\{\{ matrix\.shard \}\}-dev-server\n\s+path: test-results\//);
});

test("every private-only workflow is excluded from the public export in the release runbooks", { skip: !existsSync("private/BETA-RELEASE.md") && "public export" }, async () => {
  const { readdir } = await import("node:fs/promises");
  const privateOnly = (await readdir(".github/workflows")).filter((file) => /Exclude this file from public exports/.test(readFileSync(`.github/workflows/${file}`, "utf8").split("\n")[0]));
  assert.deepEqual(privateOnly.sort(), ["nightly-browser.yml", "quick-check.yml", "virtual-kiosk-pr.yml"]);
  const beta = readFileSync("private/BETA-RELEASE.md", "utf8");
  const exportCommand = beta.match(/^git -C \$D diff --binary .+$/m)?.[0];
  const unchangedCheck = beta.match(/^3\. \*\*The excluded paths didn't change\.\*\* `([^`]+)`/m)?.[1];
  assert.ok(exportCommand && unchangedCheck);
  const stable = readFileSync("private/STABLE-RELEASE.md", "utf8");
  const workflowGuide = readFileSync("private/WORKFLOW.md", "utf8");
  for (const file of privateOnly) {
    assert.ok(exportCommand.includes(`':(exclude).github/workflows/${file}'`), `BETA-RELEASE.md step 3 exports ${file}`);
    assert.ok(unchangedCheck.includes(` .github/workflows/${file}`), `BETA-RELEASE.md check 3 omits ${file}`);
    assert.ok(stable.includes(`\`.github/workflows/${file}\``), `STABLE-RELEASE.md omits ${file}`);
    assert.ok(workflowGuide.match(/^Public exports must explicitly exclude .+$/m)?.[0].includes(`.github/workflows/${file}`), `WORKFLOW.md omits ${file}`);
  }
});

test("Quick check and Verify do not run the virtual kiosk scenarios on pull requests themselves", () => {
  // Verify runs them only when dispatched, as one of the jobs of the release gate.
  const ci = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(ci, /\n  virtual-kiosk-browser:\n(?:    #.*\n)*    name: Virtual kiosk browser\n    if: github\.event_name == 'workflow_dispatch' && /);
  if (existsSync(".github/workflows/quick-check.yml")) assert.doesNotMatch(readFileSync(".github/workflows/quick-check.yml", "utf8"), /kiosk-virtual|playwright/);
});
