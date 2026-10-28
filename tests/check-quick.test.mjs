import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserGroupsTest, changedPaths, defaultBase, defaultTests, deviceTests, exitCodeFor, main, referenceKeys, selectQuickChecks, slowTests, StartupError } from "../scripts/check-quick.mjs";
import { spawnSync } from "node:child_process";
import { dropGitRepositoryVariables } from "../scripts/git-env.mjs";

// These tests create throwaway repositories. Repository variables that Git exports to hooks would point them at the
// real repository instead, so drop them.
dropGitRepositoryVariables();

const tests = new Map([
  ["tests/attendance-service.test.mjs", 'import { x } from "../apps/api/src/attendance-service.mjs";'],
  ["tests/foundation.test.mjs", 'await readFile(".github/workflows/ci.yml", "utf8"); await readFile("scripts/release-publication.mjs");'],
  ["tests/web-test-runner.test.mjs", 'import "../scripts/run-web-tests.mjs";'],
  ["tests/check-quick.test.mjs", 'import "../scripts/check-quick.mjs";'],
  ["tests/kiosk-poll-service.test.mjs", 'import "../apps/kiosk/src/poll-service.mjs";'],
  ["tests/kiosk-artifacts.test.mjs", 'await readFile(".github/workflows/ci.yml");'],
  ["tests-ts/module-platform.test.ts", 'import "../packages/shared/src/module-platform.ts";'],
  ["tests-ts/dashboard-conformance.test.ts", 'import "../apps/dashboard/src/main.tsx";'],
  ["tests-ts/outreach/catalog.test.ts", 'import { compose } from "../fixtures/composed-plugins.ts";'],
  ["tests-ts/plugin-selection.test.ts", 'import { compose } from "./fixtures/composed-plugins.ts";'],
]);
const names = (entries) => entries.map(({ name }) => name);

test("a source change selects the tests that reference it and the owning workspace typecheck", () => {
  const plan = selectQuickChecks({ changes: ["apps/api/src/attendance-service.mjs"], tests });
  assert.deepEqual(names(plan.typecheck), ["@lancerlogin/api"]);
  assert.deepEqual(names(plan.javascript), ["tests/attendance-service.test.mjs"]);
  assert.deepEqual(plan.typescript, []);
  assert.equal(plan.fallback, false);
  assert.match(plan.javascript[0].reasons[0], /references apps\/api\/src\/attendance-service\.mjs/);
});

test("shared contract changes typecheck every application that imports them", () => {
  const plan = selectQuickChecks({ changes: ["packages/shared/src/module-platform.ts"], tests });
  assert.deepEqual(names(plan.typecheck), ["@lancerlogin/shared", "@lancerlogin/api", "@lancerlogin/dashboard", "@lancerlogin/kiosk"]);
  assert.deepEqual(names(plan.typescript), ["tests-ts/module-platform.test.ts"]);
});

test("root build files typecheck everything and add the default set", () => {
  const plan = selectQuickChecks({ changes: ["package.json"], tests });
  assert.equal(plan.typecheck.length, 5);
  assert.deepEqual([...names(plan.javascript), ...names(plan.typescript)].sort(), [...defaultTests].sort());
});

test("changed tests run directly, while slow and device-bound suites are only reported", () => {
  const plan = selectQuickChecks({ changes: ["tests/foundation.test.mjs", ".github/workflows/ci.yml", "apps/kiosk/src/poll-service.mjs"], tests });
  assert.deepEqual(names(plan.javascript), ["tests/foundation.test.mjs"]);
  assert.deepEqual(names(plan.skipped), ["tests/kiosk-artifacts.test.mjs", "tests/kiosk-poll-service.test.mjs"]);
  assert.deepEqual(names(plan.typecheck), ["@lancerlogin/kiosk"]);
  // A slow suite still runs when it is the file being edited; a physical kiosk suite never does.
  const edited = selectQuickChecks({ changes: ["tests/kiosk-poll-service.test.mjs", "tests/kiosk-artifacts.test.mjs"], tests });
  assert.deepEqual(names(edited.javascript), ["tests/kiosk-poll-service.test.mjs"]);
  assert.deepEqual(names(edited.skipped), ["tests/kiosk-artifacts.test.mjs"]);
  assert.ok(slowTests.has("tests/kiosk-poll-service.test.mjs"));
  assert.ok(deviceTests.has("tests/kiosk-artifacts.test.mjs") && deviceTests.has("tests/kiosk-runtime.test.mjs"));
});

test("test helpers match the relative imports tests use", () => {
  assert.deepEqual(referenceKeys("tests-ts/fixtures/composed-plugins.ts"), ["tests-ts/fixtures/composed-plugins", "fixtures/composed-plugins"]);
  const plan = selectQuickChecks({ changes: ["tests-ts/fixtures/composed-plugins.ts"], tests });
  assert.deepEqual(names(plan.typescript), ["tests-ts/outreach/catalog.test.ts", "tests-ts/plugin-selection.test.ts"]);
});

test("a browser spec change runs the browser group manifest test", () => {
  const withGroups = new Map([...tests, [browserGroupsTest, 'readBrowserGroupManifest(); import "../scripts/browser-groups.mjs";']]);
  for (const changes of [["tests-browser/new-area.spec.ts"], ["tests-browser/outreach-workflow.spec.ts"]]) {
    const plan = selectQuickChecks({ changes, tests: withGroups, exists: () => false });
    assert.deepEqual(names(plan.javascript), [browserGroupsTest], changes.join());
    assert.equal(plan.fallback, false);
    assert.match(plan.javascript[0].reasons[0], /must keep its browser group/);
  }
  // Helpers are not specs, and the manifest itself maps by reference.
  assert.ok(!names(selectQuickChecks({ changes: ["tests-browser/paired-views.ts"], tests: withGroups }).javascript).includes(browserGroupsTest));
  assert.ok(existsSync(browserGroupsTest));
});

test("unmapped and documentation-only changes fall back to the small default set", () => {
  for (const changes of [["docs/DEVELOPMENT.md"], ["README.md"], ["apps/dashboard/public/logo.png"], []]) {
    const plan = selectQuickChecks({ changes, tests });
    assert.equal(plan.fallback, true, changes.join());
    assert.deepEqual([...names(plan.javascript), ...names(plan.typescript)].sort(), [...defaultTests].sort());
  }
  const unmapped = selectQuickChecks({ changes: ["apps/api/src/brand-new.ts"], tests });
  assert.deepEqual(names(unmapped.typecheck), ["@lancerlogin/api"]);
  assert.match(unmapped.notes[0], /No fast test references apps\/api\/src\/brand-new\.ts/);
  assert.equal(unmapped.fallback, true);
});

test("deleted files still select the tests that referenced them, deleted tests are dropped", () => {
  const plan = selectQuickChecks({ changes: ["apps/api/src/attendance-service.mjs", "tests/removed.test.mjs"], tests, exists: (path) => !path.startsWith("tests/removed") });
  assert.deepEqual(names(plan.javascript), ["tests/attendance-service.test.mjs"]);
});

test("--all selects every workspace and every fast test, never physical kiosk suites", () => {
  const plan = selectQuickChecks({ changes: [], tests, all: true });
  assert.equal(plan.typecheck.length, 5);
  assert.equal(plan.fallback, false);
  const selected = [...names(plan.javascript), ...names(plan.typescript)];
  assert.ok(!selected.includes("tests/kiosk-artifacts.test.mjs"));
  assert.ok(!selected.includes("tests/kiosk-poll-service.test.mjs"));
  assert.equal(selected.length, tests.size - 2);
});

test("the default set and slow list name real test files", () => {
  for (const file of [...defaultTests, ...slowTests, ...deviceTests]) assert.doesNotThrow(() => readFileSync(file), file);
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.equal(scripts["check:quick"], "node scripts/check-quick.mjs");
});

test("changed paths include commits since the merge base and uncommitted work; the base comes from configuration first", () => {
  const root = mkdtempSync(join(tmpdir(), "check-quick-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    git("init", "-q", "-b", "trunk"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    mkdirSync(join(root, "apps/api/src"), { recursive: true });
    writeFileSync(join(root, "apps/api/src/a.ts"), "export {};\n"); writeFileSync(join(root, "unchanged.txt"), "x\n");
    git("add", "."); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "apps/api/src/b.ts"), "export {};\n"); git("add", "."); git("commit", "-q", "-m", "feature");
    git("checkout", "-q", "trunk"); writeFileSync(join(root, "trunk-only.txt"), "x\n"); git("add", "."); git("commit", "-q", "-m", "trunk moves on");
    git("checkout", "-q", "feature");
    writeFileSync(join(root, "apps/api/src/a.ts"), "export const a = 1;\n"); writeFileSync(join(root, "new.mjs"), "\n");
    const { paths } = changedPaths(root, "trunk");
    assert.deepEqual(paths, ["apps/api/src/a.ts", "apps/api/src/b.ts", "new.mjs"]);
    assert.throws(() => changedPaths(root, "--help"), /Invalid base/);
    git("checkout", "-q", "--orphan", "unrelated"); git("commit", "-q", "-m", "unrelated history");
    assert.throws(() => changedPaths(root, "feature"), /shares no history with HEAD/);
    git("checkout", "-q", "-f", "feature");
    assert.deepEqual(defaultBase(root, { LANCERLOGIN_CHECK_BASE: "trunk" }), { ref: "trunk", source: "LANCERLOGIN_CHECK_BASE" });
    git("config", "lancerlogin.checkBase", "trunk");
    assert.deepEqual(defaultBase(root, {}), { ref: "trunk", source: "git config lancerlogin.checkBase" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The pre-push hook lets exit 2 through as "could not start", so only option and base errors may produce it.
test("only option and base errors exit 2; any other error exits 1 so the pre-push hook blocks", async () => {
  await assert.rejects(main(["--unknown-option"]), StartupError);
  await assert.rejects(main(["--concurrency", "99"]), StartupError);
  const root = mkdtempSync(join(tmpdir(), "check-quick-exit-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(join(root, "a.txt"), "a\n"); git("add", "."); git("commit", "-q", "-m", "initial");
    await assert.rejects(main(["--base", "missing-ref"], root), StartupError);
    // A "tests" file where the test directory belongs makes discovery throw after the base resolved: unexpected, not startup.
    writeFileSync(join(root, "tests"), "not a directory\n");
    const unexpected = await main(["--base", "HEAD", "--list"], root).then(() => undefined, (error) => error);
    assert.ok(unexpected instanceof Error); assert.equal(unexpected instanceof StartupError, false);
    assert.equal(exitCodeFor(unexpected), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.equal(exitCodeFor(new StartupError("bad option")), 2);
  assert.equal(exitCodeFor(new TypeError("bug")), 1);
  assert.equal(exitCodeFor("thrown string"), 1);
  const cli = spawnSync(process.execPath, ["scripts/check-quick.mjs", "--unknown-option"], { encoding: "utf8" });
  assert.equal(cli.status, 2, cli.stderr);
});

// The private Quick check workflow is excluded from public exports, so this only checks it where it exists.
test("the private quick-check workflow stays one cheap private-only job", { skip: !existsSync(".github/workflows/quick-check.yml") && "public export" }, () => {
  const workflow = readFileSync(".github/workflows/quick-check.yml", "utf8");
  assert.match(workflow, /if: github\.event\.repository\.private/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /timeout-minutes: 10/);
  assert.equal((workflow.split(/^jobs:$/m)[1].match(/^  [a-z-]+:$/gm) ?? []).length, 1);
  assert.doesNotMatch(workflow, /matrix|playwright|test:browser/);
  assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
  assert.match(workflow, /node scripts\/check-quick\.mjs --base "\$BASE_SHA"/);
  assert.match(workflow, /fetch-depth: 0/);
});
