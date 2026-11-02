#!/usr/bin/env node
// npm test: the JavaScript and TypeScript suites at once, each running up to testConcurrency() files in parallel.
// Eight per suite is the soaked limit (private/WORKFLOW.md, "Focused work and bounded diagnosis"); a smaller machine
// gets half its logical CPUs, never fewer than the previous limit of two.
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { runJobs } from "./parallel-jobs.mjs";

export function testConcurrency(cpus = availableParallelism()) {
  return Math.max(2, Math.min(8, Math.floor(cpus / 2)));
}

export function testJobs(concurrency = testConcurrency(), cwd = process.cwd()) {
  const flag = `--test-concurrency=${concurrency}`;
  return [
    { label: "JavaScript tests", command: process.execPath, args: ["--test", flag, "tests/**/*.test.mjs"], cwd },
    { label: "TypeScript tests", command: process.execPath, args: ["--experimental-strip-types", "--test", flag, "tests-ts/**/*.test.ts"], cwd },
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const concurrency = testConcurrency();
  process.exitCode = await runJobs(`Tests (${concurrency} files at a time in each suite)`, testJobs(concurrency));
}
