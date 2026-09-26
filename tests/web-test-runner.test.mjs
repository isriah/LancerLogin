import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discoverWebTests, kioskOnlyTests } from "../scripts/run-web-tests.mjs";

const runner = resolve("scripts/run-web-tests.mjs");
const pass = 'import test from "node:test"; test("passes", () => {});';
const fail = 'import test from "node:test"; test("fails", () => { throw new Error("intentional fixture failure"); });';

function fixture(t, { js = pass, ts = pass } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lancerlogin-web-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "tests/web.test.mjs": js,
    "tests-ts/web.test.ts": ts,
    "tests/kiosk-runtime.test.mjs": fail,
    "tests/kiosk-artifacts.test.mjs": fail,
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function run(root, ...args) {
  // Launch an independent test runner, outside the parent node:test context.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

test("web discovery preserves every current test except the two physical kiosk suites", () => {
  const selected = discoverWebTests().flatMap(({ files }) => files).sort();
  const all = ["tests", "tests-ts"].flatMap((directory) =>
    readdirSync(directory, { recursive: true })
      .map((file) => directory + "/" + file.replaceAll("\\", "/"))
      .filter((file) => /\.test\.(mjs|ts)$/.test(file))
  ).sort();
  assert.deepEqual(selected, all.filter((file) => !kioskOnlyTests.includes(file)));
  assert.ok(selected.includes("tests/pairing-service.test.mjs"));
  assert.ok(selected.includes("tests/web-updates-workerd.test.mjs"));
  assert.ok(selected.includes("tests-ts/runtime-security.test.ts"));
});

test("web runner executes JS and TypeScript while omitting failing physical kiosk fixtures", (t) => {
  const root = fixture(t, {
    js: pass + '\nimport { writeFileSync } from "node:fs"; writeFileSync("js-ran", "yes");',
    ts: pass + '\nimport { writeFileSync } from "node:fs"; const value: string = "yes"; writeFileSync("ts-ran", value);',
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(root, "js-ran"), "utf8"), "yes");
  assert.equal(readFileSync(join(root, "ts-ran"), "utf8"), "yes");
});

test("list discovers nested new suites without executing any tests", (t) => {
  const root = fixture(t, { js: fail, ts: fail });
  mkdirSync(join(root, "tests/nested"));
  writeFileSync(join(root, "tests/nested/new.test.mjs"), fail);
  const result = run(root, "--list");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tests\/nested\/new.test.mjs/);
  assert.doesNotMatch(result.stdout, /intentional fixture failure/);
});

test("a failing JavaScript suite stops before TypeScript execution", (t) => {
  const root = fixture(t, { js: fail, ts: 'throw new Error("TYPESCRIPT_MUST_NOT_RUN");' });
  const result = run(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /intentional fixture failure/);
  assert.doesNotMatch(result.stdout + result.stderr, /TYPESCRIPT_MUST_NOT_RUN/);
});

test("a failing TypeScript suite fails the web gate", (t) => {
  const result = run(fixture(t, { ts: fail }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /intentional fixture failure/);
});

test("missing suites, empty coverage and unknown arguments fail visibly", (t) => {
  const root = fixture(t);
  assert.equal(run(root, "--unknown").status, 1);
  rmSync(join(root, "tests-ts/web.test.ts"));
  assert.throws(() => discoverWebTests(root), /both JavaScript and TypeScript/);
  writeFileSync(join(root, "tests-ts/web.test.ts"), pass);
  rmSync(join(root, kioskOnlyTests[0]));
  assert.throws(() => discoverWebTests(root), /Missing kiosk suite/);
});

test("development and CI avoid duplicate complete verification", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(scripts["test:web"], "node scripts/run-web-tests.mjs");
  assert.equal(scripts["verify:dev"], "npm run verify:migrations && npm run typecheck:web && npm run test:web && npm run build:web");
  for (const name of ["typecheck:web", "build:web"]) {
    assert.match(scripts[name], /--workspace @lancerlogin\/api/);
    assert.match(scripts[name], /--workspace @lancerlogin\/dashboard/);
    assert.doesNotMatch(scripts[name], /--workspaces|@lancerlogin\/kiosk/);
  }
  assert.match(scripts["typecheck:web"], /--workspace @lancerlogin\/shared/);
  assert.match(scripts["build:web"], /verify-template-config/);
  assert.equal(scripts.test, "node --test tests/**/*.test.mjs && node --experimental-strip-types --test tests-ts/**/*.test.ts");
  assert.match(scripts["verify:all"], /verify:migrations.*typecheck.*npm test.*build/);
  assert.match(scripts["verify:release"], /verify:all.*audit:release:local/);
  assert.equal(scripts["test:release-ci"], "npm run test:web && node --test tests/kiosk-runtime.test.mjs");
  assert.equal(scripts["verify:release-ci"], "npm run verify:migrations && npm run typecheck && npm run test:release-ci && npm run build");
  assert.match(scripts["test:kiosk"], /kiosk-runtime\.test\.mjs.*kiosk-artifacts\.test\.mjs/);

  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /npm run verify:dev/);
  assert.match(ci, /npm run verify:kiosk/);
  assert.match(ci, /npm run verify:release-ci/);
  assert.doesNotMatch(ci, /npm run verify:all/);
  assert.match(ci, /outputs\.full == 'true'[\s\S]*sudo "\$\(command -v node\)" --test tests\/kiosk-artifacts\.test\.mjs/);
  assert.match(ci, /npm run audit:release/);
  assert.match(ci, /startsWith\(github\.event\.head_commit\.message, 'Release v'\)[\s\S]*npm run test:browser -- --shard=/);
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(release, /package-kiosk\.mjs release\/artifacts --require-unprivileged/);
});
