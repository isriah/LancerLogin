import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runJobs } from "../scripts/parallel-jobs.mjs";
import { workspaceTypechecks } from "../scripts/typecheck-workspaces.mjs";
import { communityBaselines } from "../scripts/rehearse-community-upgrade.mjs";
import { testConcurrency, testJobs } from "../scripts/run-tests.mjs";

const job = (label, code) => ({ label, command: process.execPath, args: ["-e", code] });

test("parallel jobs print each job's output as one block and name every failure", async () => {
  let text = "";
  const status = await runJobs("Synthetic jobs", [
    job("slow pass", "setTimeout(() => console.log('slow output'), 200)"),
    job("quick fail", "console.error('quick output'); process.exit(3)"),
    job("pass", "console.log('pass output')"),
  ], { write: (chunk) => { text += chunk; } });
  assert.equal(status, 1);
  assert.match(text, /=== quick fail: FAILED \(exit 3\) in [\d.]+s ===\nquick output\n/);
  assert.match(text, /=== slow pass: passed in [\d.]+s ===\nslow output\n/);
  assert.match(text, /Synthetic jobs failed in [\d.]+s: quick fail\.\n$/);
  assert.equal(await runJobs("Synthetic jobs", [job("pass", "")], { write: () => {} }), 0);
});

test("npm test runs every JavaScript and TypeScript test file at the soaked concurrency", () => {
  // Eight files per suite is the soaked limit; smaller machines get half their CPUs, never fewer than two.
  assert.deepEqual([1, 2, 4, 6, 12, 16, 24, 64].map((cpus) => testConcurrency(cpus)), [2, 2, 2, 3, 6, 8, 8, 8]);
  const jobs = testJobs(8, "root");
  assert.deepEqual(jobs.map(({ label, args, cwd }) => ({ label, args, cwd })), [
    { label: "JavaScript tests", args: ["--test", "--test-concurrency=8", "tests/**/*.test.mjs"], cwd: "root" },
    { label: "TypeScript tests", args: ["--experimental-strip-types", "--test", "--test-concurrency=8", "tests-ts/**/*.test.ts"], cwd: "root" },
  ]);
  assert.ok(jobs.every(({ command }) => command === process.execPath));
});

test("verify:migrations runs the fresh schema check and every Community baseline", () => {
  const source = readFileSync("scripts/verify-migrations.mjs", "utf8");
  assert.match(source, /scripts\/verify-d1-migrations\.mjs/);
  assert.match(source, /communityBaselines\.map/);
  assert.deepEqual(communityBaselines, ["0038_page_walkthroughs.sql", "0039_discord_attendance_delivery_batches.sql", "0061_update_channels.sql"]);
});

test("typecheck covers every workspace with a typecheck script, and verify:all builds each workspace once", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(scripts.typecheck, "node scripts/typecheck-workspaces.mjs");
  assert.deepEqual(workspaceTypechecks(process.cwd()).map(({ name }) => name).sort(),
    ["@lancerlogin/api", "@lancerlogin/dashboard", "@lancerlogin/kiosk", "@lancerlogin/module-sdk", "@lancerlogin/shared"]);
  // verify:all has just typechecked, so it builds the dashboard without its build script's own tsc. Every other
  // workspace with a build script is still built.
  assert.match(scripts["verify:all"], /npm run typecheck && npm test && npm run build:after-typecheck$/);
  const dashboard = JSON.parse(readFileSync("apps/dashboard/package.json", "utf8")).scripts;
  assert.equal(dashboard.build, `tsc --noEmit -p tsconfig.json && ${dashboard["build:vite"]}`);
  assert.equal(dashboard["prebuild:vite"], dashboard.prebuild);
  const built = [...scripts["build:after-typecheck"].matchAll(/--workspace (\S+)/g)].map((match) => match[1]).sort();
  const withBuild = workspaceTypechecks(process.cwd()).map(({ name, directory }) => ({ name, build: JSON.parse(readFileSync(`${directory}/package.json`, "utf8")).scripts?.build }))
    .filter(({ build }) => build).map(({ name }) => name).sort();
  assert.deepEqual(built, withBuild);
  assert.match(scripts["build:after-typecheck"], /npm run build:vite --workspace @lancerlogin\/dashboard && node scripts\/verify-template-config\.mjs$/);
  assert.match(scripts.build, /--workspaces --if-present && node scripts\/verify-template-config\.mjs$/);
});
