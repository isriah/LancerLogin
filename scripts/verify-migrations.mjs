#!/usr/bin/env node
// npm run verify:migrations: the fresh-schema check and one Community upgrade rehearsal per baseline.
// Each job makes its own temporary folder, wrangler configuration and persisted database, so they run at once.
import { resolve } from "node:path";
import { communityBaselines } from "./rehearse-community-upgrade.mjs";
import { runJobs } from "./parallel-jobs.mjs";

const workspace = resolve(process.cwd());
const node = (script, ...args) => ({ command: process.execPath, args: [script, ...args], cwd: workspace });
const jobs = [
  { label: "fresh schema", ...node("scripts/verify-d1-migrations.mjs") },
  ...communityBaselines.map((baseline) => ({ label: `Community upgrade from ${baseline}`, ...node("scripts/rehearse-community-upgrade.mjs", baseline) })),
];
process.exitCode = await runJobs("Migration verification", jobs);
