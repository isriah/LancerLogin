import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flakySummary, reportTests } from "../scripts/browser-test-summary.mjs";

// The gate keeps one retry in CI, so a test that fails once and then passes still passes the gate. The job summary must
// name it, so it can be recorded in the release evidence and fixed before the next beta.
const result = (status, message) => ({ status, duration: 10, ...(message ? { error: { message } } : {}) });
const report = {
  suites: [
    { title: "a.spec.ts", file: "a.spec.ts", specs: [
      { title: "steady", file: "a.spec.ts", line: 3, tests: [{ status: "expected", results: [result("passed")] }] },
      { title: "refreshes | twice", file: "a.spec.ts", line: 9, tests: [{ status: "flaky", results: [result("failed", "\u001b[31mError: expect(received).toBe(expected)\u001b[39m\n\nExpected: 2"), result("passed")] }] },
    ], suites: [{ title: "group", file: "a.spec.ts", specs: [{ title: "inner", file: "a.spec.ts", line: 20, tests: [{ status: "flaky", results: [result("timedOut", "Test timeout of 120000ms exceeded."), result("passed")] }] }] }] },
    { title: "b.spec.ts", file: "b.spec.ts", specs: [{ title: "broken", file: "b.spec.ts", line: 5, tests: [{ status: "unexpected", results: [result("failed", "x"), result("failed", "x")] }] }] },
  ],
};

test("the job summary lists each flaky test with its file, line, title and first failure", () => {
  assert.deepEqual(reportTests(report).map((entry) => `${entry.file}:${entry.line} ${entry.title} ${entry.status}`), [
    "a.spec.ts:3 steady expected", "a.spec.ts:9 refreshes | twice flaky", "a.spec.ts:20 group › inner flaky", "b.spec.ts:5 broken unexpected",
  ]);
  const summary = flakySummary(report, "Core browser shard 1/4");
  assert.match(summary, /^### Core browser shard 1\/4: flaky tests\n/);
  assert.match(summary, /2 of 4 tests failed and then passed on retry/);
  assert.ok(summary.includes("| `a.spec.ts:9` refreshes \\| twice | Error: expect(received).toBe(expected) |"));
  assert.ok(summary.includes("| `a.spec.ts:20` group › inner | Test timeout of 120000ms exceeded. |"));
  assert.doesNotMatch(summary, /steady|broken/);
  assert.match(flakySummary({ suites: [report.suites[0].specs[0]].map((spec) => ({ specs: [spec] })) }), /None: 1 tests, no test needed its retry/);
});

test("every release-gate browser shard keeps one retry, writes a JSON report and lists its flaky tests", () => {
  const config = readFileSync("playwright.config.ts", "utf8");
  assert.match(config, /retries: process\.env\.CI \? 1 : 0/);
  assert.match(config, /reporter: process\.env\.CI \? \[\["github"\], \["json", \{ outputFile: "playwright-report\/browser-results\.json" \}\]\]/);
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("\r\n", "\n");
  for (const [job, label] of [["core-browser-shard", "Core browser shard ${{ matrix.shard }}/4"], ["plugin-browser-shard", "Plugin browser shard ${{ matrix.shard }}/1"], ["integration-browser-shard", "Integration browser shard ${{ matrix.shard }}/1"]]) {
    const body = workflow.match(new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)\\n  [a-z-]+:\\n`))?.[1];
    assert.ok(body, job);
    assert.ok(body.includes(`if: \${{ !cancelled() }}\n        run: node scripts/browser-test-summary.mjs playwright-report/browser-results.json "${label}" >> "$GITHUB_STEP_SUMMARY"`), job);
    assert.match(body, /uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: browser-report-[a-z]+-\$\{\{ matrix\.shard \}\}\n\s+path: playwright-report\/browser-results\.json/, job);
  }
});
