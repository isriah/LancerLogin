import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affectedPlugins, browserGroupsTest, buildTestClosures, changedPaths, closureChain, coverHeaders, defaultBase, defaultTests, deviceTests, executedFiles, exitCodeFor, explainPath, globPattern, literalDirectoryReads, main, referenceKeys, selectQuickChecks, slowTests, StartupError } from "../scripts/check-quick.mjs";
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
  ["tests/kiosk-poll-service.test.mjs", 'import "../apps/kiosk/src/kiosk-poll.mjs";'],
  ["tests/kiosk-artifacts.test.mjs", 'await readFile(".github/workflows/ci.yml");'],
  ["tests-ts/module-platform.test.ts", 'import "../packages/shared/src/module-platform.ts";'],
  ["tests-ts/outreach-module-platform.test.ts", 'import "./fixtures/outreach-plugin.ts";'],
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
  const plan = selectQuickChecks({ changes: ["tests/foundation.test.mjs", ".github/workflows/ci.yml", "apps/kiosk/src/kiosk-poll.mjs"], tests });
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
  assert.match(workflow, /node scripts\/check-quick\.mjs --base "\$BASE_SHA" --selection "\$QUICK_CHECK_SELECTION"/);
  assert.match(workflow, /node scripts\/check-quick\.mjs --all --base HEAD --selection "\$QUICK_CHECK_SELECTION"/);
  // CI keeps text matching until the Actions budget is known; switching it to full is this one line.
  assert.match(workflow, /^ {10}QUICK_CHECK_SELECTION: text$/m);
  assert.match(workflow, /fetch-depth: 0/);
});

// Without these, a plugin pin that can't be fetched turns about 340 plugin-gated tests into skips that pass.
test("CI and Quick check fail plugin-gated tests instead of skipping them", () => {
  const variables = ["LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN", "LANCERLOGIN_REQUIRE_CARPOOL_PLUGIN", "LANCERLOGIN_REQUIRE_VISITS_PLUGIN"];
  const verifyJob = readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("\r\n", "\n").split(/^  verify:$/m)[1]?.split(/^  [a-z-]+:$/m)[0] ?? "";
  const jobEnv = /^    env:\n((?: {6}.+\n)+)/m.exec(verifyJob)?.[1] ?? "";
  for (const variable of variables) assert.match(jobEnv, new RegExp(`^ {6}${variable}: "1"$`, "m"), `ci.yml verify job env sets ${variable}`);
  if (!existsSync(".github/workflows/quick-check.yml")) return; // excluded from public exports
  const quick = readFileSync(".github/workflows/quick-check.yml", "utf8").replaceAll("\r\n", "\n");
  const checkStep = quick.split("- name: Typecheck and test what the change touches")[1] ?? "";
  for (const variable of variables) assert.match(checkStep, new RegExp(`^ {10}${variable}: "1"$`, "m"), `quick-check.yml check step sets ${variable}`);
});

// A synthetic repository for the closure walker. Paths are invented so the directory-read lint below never sees them
// as real folders.
const synthetic = new Map([
  ["packages/pkg/package.json", JSON.stringify({ name: "@synthetic/pkg", exports: { ".": "./main.ts", "./extra": "./extra.ts" } })],
  ["packages/pkg/main.ts", 'export { x } from "./inner.js";\nimport data from "../../settings/pins.json" with { type: "json" };'],
  ["packages/pkg/inner.ts", "export const x = 1;"],
  ["packages/pkg/extra.ts", 'import "./never-read-as-text.css";'],
  ["packages/pkg/never-read-as-text.css", ""],
  ["apps/app/index.ts", 'import { x } from "@synthetic/pkg";\nconst text = "settings/not-an-edge.json";'],
  ["settings/pins.json", "{}"],
  ["settings/not-an-edge.json", "{}"],
  ["scripts/tool.mjs", 'import "./tool-helper.mjs";'],
  ["scripts/tool-helper.mjs", ""],
  ["tests/fixtures/db.mjs", '// quick-check: covers data/migrations/**\nexport const read = () => readdirSync(dir);'],
  ["tests/fixtures/output-dir/keep.txt", ""],
  ["tests/fixtures/server.mjs", 'import "../../apps/app/index.ts";'],
  ["data/migrations/0001_first.sql", ""],
  ["tests/a.test.mjs", 'import { read } from "./fixtures/db.mjs";\nconst { x } = await import("../apps/app/index.ts");\nspawnSync(process.execPath, [join(root, "scripts", "tool.mjs")]);\nconst out = join(root, "tests/fixtures/output-dir");'],
  ["tests/b.test.mjs", 'await readFile("tests/fixtures/server.mjs", "utf8");\nawait readFile("packages/pkg/extra.ts", "utf8");\nawait readFile("tests/fixtures/db.mjs", "utf8");'],
  ["tests-ts/c.test.ts", '// quick-check: covers .synthetic-version\nimport "@synthetic/pkg/extra";'],
  [".synthetic-version", "1\n"],
]);
const syntheticGraph = () => buildTestClosures((path) => synthetic.get(path), () => [...synthetic.keys()]);

test("closures follow imports, re-exports, dynamic and JSON imports, workspace packages and spawned scripts", () => {
  const { closures, covers } = syntheticGraph();
  const a = closures.get("tests/a.test.mjs");
  for (const file of ["tests/fixtures/db.mjs", "apps/app/index.ts", "packages/pkg/main.ts", "packages/pkg/inner.ts", "settings/pins.json", "scripts/tool.mjs", "scripts/tool-helper.mjs"]) assert.ok(a.has(file), file);
  // Application code's string literals and folders named in test code are not edges.
  assert.ok(!a.has("settings/not-an-edge.json"));
  assert.ok(!a.has("tests/fixtures/output-dir/keep.txt"));
  assert.deepEqual(closureChain(a, "settings/pins.json"), ["tests/a.test.mjs", "apps/app/index.ts", "packages/pkg/main.ts", "settings/pins.json"]);
  // A file a test only reads is a leaf: its own imports are not followed.
  const b = closures.get("tests/b.test.mjs");
  assert.ok(b.has("tests/fixtures/server.mjs") && b.has("packages/pkg/extra.ts"));
  assert.ok(!b.has("apps/app/index.ts") && !b.has("packages/pkg/never-read-as-text.css"));
  assert.ok(closures.get("tests-ts/c.test.ts").has("packages/pkg/never-read-as-text.css"));
  // Headers apply to the test itself and to every test whose closure includes the helper declaring them.
  assert.deepEqual(covers.get("tests/a.test.mjs"), ["data/migrations/**"]);
  assert.deepEqual(covers.get("tests/b.test.mjs"), []);
  assert.deepEqual(covers.get("tests-ts/c.test.ts"), [".synthetic-version"]);
});

test("closure and declared inputs select tests that never name the changed file", () => {
  const { closures, covers, headers } = syntheticGraph();
  const tests = new Map([...synthetic].filter(([path]) => /\.test\./.test(path)));
  const plan = (changes) => selectQuickChecks({ changes, tests, closures, covers });
  const all = (result) => [...names(result.javascript), ...names(result.typescript)];
  assert.deepEqual(all(plan(["settings/pins.json"])), ["tests/a.test.mjs"]);
  assert.match(plan(["settings/pins.json"]).javascript[0].reasons[0], /imports or reads settings\/pins\.json/);
  assert.deepEqual(all(plan(["data/migrations/0002_next.sql"])), ["tests/a.test.mjs"]);
  assert.match(plan(["data/migrations/0002_next.sql"]).javascript[0].reasons[0], /covers data\/migrations\/\*\*/);
  // A root file with no reference text still selects through a header, and is noted when nothing selects it.
  assert.deepEqual(all(plan([".synthetic-version"])), ["tests-ts/c.test.ts"]);
  assert.deepEqual(plan([".synthetic-version"]).notes, []);
  assert.match(plan([".unknown-root"]).notes[0], /No fast test imports, reads or declares the root file \.unknown-root/);
  assert.match(plan(["assets/logo.webp"]).notes[0], /No fast test imports, reads or declares assets\/logo\.webp \(\.webp files are not matched by text\)/);
  const why = explainPath("data/migrations/0002_next.sql", { tests, closures, headers }).join("\n");
  assert.match(why, /tests\/a\.test\.mjs -> imports tests\/fixtures\/db\.mjs declares covers data\/migrations\/\*\*/);
  assert.match(explainPath("settings/pins.json", { tests, closures, headers }).join("\n"), /tests\/a\.test\.mjs -> imports apps\/app\/index\.ts -> imports packages\/pkg\/main\.ts -> imports settings\/pins\.json/);
  // A file only read as data passes on no headers.
  assert.deepEqual(explainPath("data/migrations/0002_next.sql", { tests, closures, headers }).filter((line) => line.includes("b.test")), []);
});

test("root package.json keeps its own rule even when tests read it", () => {
  const closures = new Map([["tests/attendance-service.test.mjs", new Set(["package.json"])]]);
  const plan = selectQuickChecks({ changes: ["package.json"], tests, closures });
  assert.deepEqual([...names(plan.javascript), ...names(plan.typescript)].sort(), [...defaultTests].sort());
});

test("pin and composition changes run each affected plugin's module gate and the composition suite", () => {
  const withComposition = new Map([...tests, ["tests-ts/module-composition.test.ts", 'import "../scripts/compose-modules.mjs";']]);
  const closures = new Map([["tests-ts/module-composition.test.ts", new Set(["scripts/official-modules.json", "scripts/compose-modules.mjs"])]]);
  const pin = selectQuickChecks({ changes: ["scripts/official-modules.json"], tests: withComposition, closures });
  assert.deepEqual(names(pin.modules), ["carpool", "hour-tracking"]);
  assert.ok(names(pin.typescript).includes("tests-ts/module-composition.test.ts"));
  assert.deepEqual(names(pin.skipped), []);
  assert.deepEqual(affectedPlugins("tests/fixtures/carpool.modules.json"), ["carpool"]);
  assert.deepEqual(affectedPlugins("module-tests/hour-tracking.json"), ["hour-tracking"]);
  assert.deepEqual(affectedPlugins("module-tests/attendance.json"), []);
  assert.deepEqual(affectedPlugins("scripts/test-plugin-sources.mjs"), ["carpool", "hour-tracking"]);
  assert.deepEqual(affectedPlugins("apps/api/src/plugin-selection.ts"), []);
  // Anything else leaves the composition suite to npm test.
  const other = selectQuickChecks({ changes: ["apps/api/src/plugin-selection.ts"], tests: withComposition, closures: new Map([["tests-ts/module-composition.test.ts", new Set(["apps/api/src/plugin-selection.ts"])]]) });
  assert.deepEqual(names(other.skipped), ["tests-ts/module-composition.test.ts"]);
  assert.deepEqual(other.modules, []);
});

test("the text selection ignores closures, headers and the pin rule", async () => {
  const withComposition = new Map([...tests, ["tests-ts/module-composition.test.ts", 'import "../scripts/compose-modules.mjs";']]);
  const closures = new Map([["tests-ts/module-composition.test.ts", new Set(["scripts/official-modules.json"])], ["tests/attendance-service.test.mjs", new Set(["scripts/official-modules.json"])]]);
  const covers = new Map([["tests/foundation.test.mjs", ["scripts/*.json"]]]);
  const text = selectQuickChecks({ changes: ["scripts/official-modules.json"], tests: withComposition, closures, covers, selection: "text" });
  assert.deepEqual(text.modules, []);
  assert.equal(text.fallback, true);
  assert.ok(!names(text.javascript).includes("tests/attendance-service.test.mjs") && !names(text.javascript).includes("tests/foundation.test.mjs"));
  const full = selectQuickChecks({ changes: ["scripts/official-modules.json"], tests: withComposition, closures, covers });
  assert.deepEqual(names(full.modules), ["carpool", "hour-tracking"]);
  assert.ok(names(full.javascript).includes("tests/attendance-service.test.mjs") && names(full.javascript).includes("tests/foundation.test.mjs"));
  await assert.rejects(main(["--selection", "closure"]), StartupError);
});

test("a changed slow suite is listed only as run", () => {
  const plan = selectQuickChecks({ changes: ["apps/kiosk/src/kiosk-poll.mjs", "tests/kiosk-poll-service.test.mjs"], tests });
  assert.deepEqual(names(plan.javascript), ["tests/kiosk-poll-service.test.mjs"]);
  assert.deepEqual(names(plan.skipped), []);
});

test("globs and headers", () => {
  assert.ok(globPattern("apps/api/migrations/**").test("apps/api/migrations/0001_x.sql"));
  assert.ok(globPattern("tests/fixtures/module-plugins/**").test("tests/fixtures/module-plugins/example/src/a.ts"));
  assert.ok(!globPattern("apps/dashboard/src/*.css").test("apps/dashboard/src/nested/a.css"));
  assert.ok(globPattern(".node-version").test(".node-version") && !globPattern(".node-version").test("x.node-version"));
  assert.deepEqual(coverHeaders("// quick-check: covers a/** b/*.json\nconst x = 1;\n  // quick-check: covers c"), ["a/**", "b/*.json", "c"]);
});

const repositoryFiles = (() => { try { return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean); } catch { return undefined; } })();
const readRepository = (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
let repositoryGraph;
const graph = () => repositoryGraph ??= buildTestClosures(readRepository, () => repositoryFiles);

// PR #108 bumped the Outreach pin and broke two suites that Quick check, matching text one
// hop deep, did not run; #109 fixed tests-ts/fixtures/backup-database.ts and again missed carpool-platform.
test("the closures reach what #108 and #109 changed", { skip: !repositoryFiles && "no git checkout" }, () => {
  const { closures } = graph();
  assert.ok(closures.get("tests-ts/module-plugin-worker.test.ts").has("scripts/official-modules.json"));
  assert.ok(closures.get("tests-ts/carpool-platform.test.ts").has("scripts/official-modules.json"));
  assert.ok(closures.get("tests-ts/carpool-platform.test.ts").has("tests-ts/fixtures/backup-database.ts"));
});

test("the closure walk stays fast", { skip: !repositoryFiles && "no git checkout" }, () => {
  const started = performance.now();
  buildTestClosures(readRepository, () => repositoryFiles);
  // About 0.75 s on Windows for about 140 tests over about 900 files; a large regression means a broken walk.
  assert.ok(performance.now() - started < 5000);
});

// Directory reads, fixture copies and globs are invisible to the walk. Each literal one in test code must be declared
// with a `quick-check: covers` header in its file or closure, and every declared glob must still match a file.
test("every literal directory read in test code is declared, and every declared glob matches a file", { skip: !repositoryFiles && "no git checkout" }, () => {
  const { closureOf } = graph();
  const testCode = repositoryFiles.filter((file) => /^(?:tests|tests-ts|private)\/.+\.(?:mjs|js|ts|tsx)$/.test(file) && !file.startsWith("tests/fixtures/module-plugins/"));
  const headersOf = (file) => coverHeaders(readRepository(file) ?? "");
  const undeclared = [];
  for (const file of testCode) for (const { call, directory, line } of literalDirectoryReads(file, readRepository(file) ?? "", repositoryFiles)) {
    const patterns = executedFiles(closureOf(file)).flatMap(headersOf).map(globPattern);
    if (!repositoryFiles.some((path) => path.startsWith(`${directory}/`) && patterns.some((pattern) => pattern.test(path)))) undeclared.push(`${file}:${line} ${call}(${directory})`);
  }
  assert.deepEqual(undeclared, [], "add // quick-check: covers <glob> to the file or the helper it imports");
  const stale = repositoryFiles.filter((file) => /^(?:tests|tests-ts|scripts|private)\//.test(file)).flatMap((file) => headersOf(file).filter((glob) => !repositoryFiles.some((path) => globPattern(glob).test(path))).map((glob) => `${file}: ${glob}`));
  assert.deepEqual(stale, []);
  // Built at run time so this file's own text holds no directory read for the lint to find.
  const call = (name, argument) => `${name}(${argument}, to);`;
  const sample = [call("readdirSync", '"apps/api/migrations"'), call("cpSync", "`tests/fixtures/module-plugins/${name}`"), call("readdir", 'join(root, "releases")'), call("readdir", 'join(coreRoot, ".github/workflows")')].join("\n");
  assert.deepEqual(literalDirectoryReads("tests/x.test.mjs", sample, repositoryFiles).map(({ directory }) => directory), ["apps/api/migrations", "tests/fixtures/module-plugins", ".github/workflows"]);
});
