// quick-check: covers apps/api/src/worker/**
// The Worker's own source as text, for tests that pin a line of it: apps/api/src/index.ts (the entry point and the
// route table) and the files under apps/api/src/worker/ that hold the route handlers it calls.
import { readFileSync, readdirSync } from "node:fs";

const repositoryRoot = new URL("../../", import.meta.url);

/** Repository paths of the Worker's entry point and every file under apps/api/src/worker/. */
export const workerSourceFiles = () => [
  "apps/api/src/index.ts",
  ...readdirSync(new URL("apps/api/src/worker/", repositoryRoot)).filter((name) => name.endsWith(".ts")).sort().map((name) => `apps/api/src/worker/${name}`),
];

/** The text of all of those files, joined. */
export const workerSource = () => workerSourceFiles().map((file) => readFileSync(new URL(file, repositoryRoot), "utf8")).join("\n");
