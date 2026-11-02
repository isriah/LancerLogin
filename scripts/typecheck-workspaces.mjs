#!/usr/bin/env node
// npm run typecheck: every workspace's typecheck script, in parallel, like `npm run typecheck --workspaces --if-present`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runJobs } from "./parallel-jobs.mjs";

export function workspaceTypechecks(root) {
  const patterns = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];
  const directories = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `${parent}/${entry.name}`).sort();
  });
  return directories.filter((directory) => existsSync(join(root, directory, "package.json"))).flatMap((directory) => {
    const manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
    return typeof manifest.scripts?.typecheck === "string" ? [{ name: manifest.name, directory, script: manifest.scripts.typecheck }] : [];
  });
}

function command(root, { name, directory, script }) {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  // A plain tsc script runs directly, which avoids an npm start-up per workspace; anything else goes through npm.
  if (/^tsc(?: [\w./-]+)*$/.test(script) && existsSync(tsc)) return { command: process.execPath, args: [tsc, ...script.split(" ").slice(1)], cwd: join(root, directory) };
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) return { command: process.execPath, args: [npmCli, "run", "typecheck", "--workspace", name], cwd: root };
  throw new Error(`Run ${name}'s typecheck through npm: npm run typecheck --workspace ${name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(process.cwd());
  process.exitCode = await runJobs("Typecheck", workspaceTypechecks(root).map((workspace) => ({ label: workspace.name, ...command(root, workspace) })));
}
