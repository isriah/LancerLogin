import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hooksPath, installHooks, uninstallHooks } from "../scripts/git-hooks.mjs";
import { dropGitRepositoryVariables } from "../scripts/git-env.mjs";
import { findShell, requireTool, toolSkip } from "./fixtures/host-tools.mjs";

// These tests create throwaway repositories. Repository variables that Git exports to hooks would point them at the
// real repository instead, so drop them.
dropGitRepositoryVariables();

const hook = resolve(".githooks/pre-push");

// The hook runs node from sh: Git for Windows ships sh beside git (never the WSL launcher); Linux and macOS have it on PATH.
const shell = findShell("sh");

function repository() {
  const root = mkdtempSync(join(tmpdir(), "git-hooks-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  return root;
}

test("the hook is opt-in: no install, prepare or postinstall script installs it", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(scripts["hooks:install"], "node scripts/git-hooks.mjs install");
  assert.equal(scripts["hooks:uninstall"], "node scripts/git-hooks.mjs uninstall");
  for (const name of ["install", "preinstall", "postinstall", "prepare", "prepublish"]) assert.ok(!scripts[name] || !/hooks/.test(scripts[name]), name);
  assert.match(readFileSync(".gitattributes", "utf8"), /^\.githooks\/\* text eol=lf$/m);
  const source = readFileSync(hook, "utf8");
  assert.ok(source.startsWith("#!/bin/sh\n"));
  assert.doesNotMatch(source, /\r/);
  assert.match(source, /git push --no-verify/);
});

test("install points core.hooksPath at .githooks, uninstall removes only that setting", () => {
  const root = repository();
  const hooksSetting = () => spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).stdout.trim();
  try {
    assert.match(installHooks(root), /no-verify/);
    assert.equal(hooksSetting(), hooksPath);
    assert.match(installHooks(root), /Installed/);
    assert.match(uninstallHooks(root), /Uninstalled/);
    assert.equal(hooksSetting(), "");
    assert.match(uninstallHooks(root), /No hooks path/);
    execFileSync("git", ["-C", root, "config", "core.hooksPath", "other-hooks"]);
    assert.throws(() => installHooks(root), /already other-hooks/);
    assert.throws(() => uninstallHooks(root), /leaving it unchanged/);
    assert.equal(hooksSetting(), "other-hooks");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-push skips in CI and without node_modules, blocks only on a failed check", { skip: toolSkip(shell) }, () => {
  requireTool(shell);
  const root = repository();
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(hook, join(root, "pre-push"));
    // A stand-in quick check whose exit status the test controls.
    writeFileSync(join(root, "scripts", "check-quick.mjs"), "process.exitCode = Number(process.env.FAKE_STATUS);\n");
    const { CI: _ci, ...environment } = shell.env();
    const run = (env) => spawnSync(shell.path, ["pre-push"], { cwd: root, encoding: "utf8", env: { ...environment, ...env } });

    let result = run({ CI: "true", FAKE_STATUS: "1" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");

    result = run({ FAKE_STATUS: "1" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /node_modules is missing; skipping/);

    mkdirSync(join(root, "node_modules"));
    assert.equal(run({ FAKE_STATUS: "0" }).status, 0);
    result = run({ FAKE_STATUS: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /push blocked\. Bypass once with: git push --no-verify/);
    result = run({ FAKE_STATUS: "2" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /could not start/);

    // Git exports repository variables to hooks; the check must not inherit them.
    writeFileSync(join(root, "scripts", "check-quick.mjs"), "process.exitCode = process.env.GIT_INDEX_FILE || process.env.GIT_DIR ? 1 : 0;\n");
    assert.equal(run({ GIT_DIR: join(root, ".git"), GIT_INDEX_FILE: join(root, ".git", "index") }).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook path stays generic product tooling", () => {
  assert.equal(dirname(hook).endsWith(".githooks"), true);
  assert.doesNotMatch(readFileSync(hook, "utf8"), /private\/|codex\/|C:\//);
});
