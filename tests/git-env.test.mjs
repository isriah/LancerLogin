import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropGitRepositoryVariables, gitRepositoryVariables, isolatedGitEnv } from "../scripts/git-env.mjs";

test("isolatedGitEnv drops git's repository variables in any case and keeps everything else", () => {
  const env = { PATH: "/bin", GIT_DIR: "/r/.git", git_index_file: "/r/.git/index", GIT_CEILING_DIRECTORIES: "/", GIT_AUTHOR_NAME: "Synthetic", GIT_TERMINAL_PROMPT: "0" };
  assert.deepEqual(isolatedGitEnv(env), { PATH: "/bin", GIT_AUTHOR_NAME: "Synthetic", GIT_TERMINAL_PROMPT: "0" });
  assert.deepEqual(isolatedGitEnv(env, { GCM_INTERACTIVE: "never" }), { PATH: "/bin", GIT_AUTHOR_NAME: "Synthetic", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
  assert.equal(env.GIT_DIR, "/r/.git", "the input is not modified");
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_NAMESPACE"]) assert.ok(gitRepositoryVariables.includes(name), name);
  const own = { ...env };
  dropGitRepositoryVariables(own);
  assert.deepEqual(own, { PATH: "/bin", GIT_AUTHOR_NAME: "Synthetic", GIT_TERMINAL_PROMPT: "0" });
});

// Regression: a test that builds throwaway repositories, started with a hook's GIT_DIR and GIT_INDEX_FILE, once
// re-initialized the hook's repository. Point those variables at a separate scratch repository (never this checkout)
// and check that the test leaves it exactly as it was.
test("a temporary-repository test started with a hook's GIT_DIR and GIT_INDEX_FILE leaves that repository untouched", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-git-env-guard-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", scratch, ...args], { encoding: "utf8", env: isolatedGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("config", "user.name", "Scratch guard");
  git("config", "user.email", "scratch-guard@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(scratch, "README.md"), "scratch\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "Scratch");
  const gitDirectory = join(scratch, ".git");
  const snapshot = () => ({
    config: git("config", "--list", "--local"),
    head: git("rev-parse", "HEAD"),
    refs: git("for-each-ref"),
    index: readFileSync(join(gitDirectory, "index")).toString("base64"),
  });
  const before = snapshot();
  assert.match(before.config, /core\.bare=false/);

  const env = { ...isolatedGitEnv(), GIT_DIR: gitDirectory, GIT_INDEX_FILE: join(gitDirectory, "index") };
  // A nested test run that inherits the runner's context reports nothing and exits early.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "tests/test-plugin-sources.test.mjs"], { encoding: "utf8", windowsHide: true, env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /pass 2/);
  assert.deepEqual(snapshot(), before);
});
