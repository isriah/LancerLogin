// Lists the flaky browser tests (failed, then passed on retry) from a Playwright JSON report as Markdown, for the CI
// job summary. The gate keeps one retry, so a flaky test passes the gate; this makes it visible so it can be recorded
// in the release evidence and fixed before the next beta (private/BETA-RELEASE.md step 4).
//
//   node scripts/browser-test-summary.mjs <report.json> [title]
//
// Prints to stdout; CI appends it to $GITHUB_STEP_SUMMARY. A missing report (Playwright never started) prints a note.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Every test in a Playwright JSON report, with its file, line, full title, status and attempts. */
export function reportTests(report) {
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      tests.push({ file: String(spec.file ?? suite.file ?? "").replaceAll("\\", "/"), line: spec.line, title: [...titles, spec.title].join(" › "), project: test.projectName ?? "", status: test.status, results: test.results ?? [] });
    }
    // Top-level suites are spec files; every nested suite is a describe block whose title prefixes its tests.
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return tests;
}

const firstLine = (result) => String(result.error?.message ?? result.errors?.[0]?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((line) => line.trim())?.trim() ?? "";
const cell = (text) => text.replaceAll("|", "\\|").slice(0, 200);

/** Markdown for the job summary: the flaky tests with their first failure, or a line saying there were none. */
export function flakySummary(report, title = "Browser tests") {
  const tests = reportTests(report);
  const flaky = tests.filter((test) => test.status === "flaky");
  const lines = [`### ${title}: flaky tests`, ""];
  if (!flaky.length) return [...lines, `None: ${tests.length} tests, no test needed its retry.`, ""].join("\n");
  lines.push(`${flaky.length} of ${tests.length} tests failed and then passed on retry. Record each in the release evidence and fix it before the next beta.`, "", "| Test | First failure |", "| --- | --- |");
  for (const test of flaky) lines.push(`| \`${cell(`${test.file}:${test.line}`)}\` ${cell(test.title)} | ${cell(firstLine(test.results.find((result) => result.status !== "passed") ?? {}))} |`);
  return [...lines, ""].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, title] = process.argv.slice(2);
  if (!path) { console.error("Usage: node scripts/browser-test-summary.mjs <report.json> [title]"); process.exit(2); }
  if (!existsSync(path)) console.log(`### ${title ?? "Browser tests"}: flaky tests\n\nNo Playwright JSON report at ${path}; the tests did not run to completion.\n`);
  else console.log(flakySummary(JSON.parse(readFileSync(path, "utf8")), title));
}
