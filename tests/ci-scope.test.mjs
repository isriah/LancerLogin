import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedFiles, classifyChange, docsSiteTest, scopeOutputs, selectDocsTests } from "../scripts/ci-scope.mjs";
import { isolatedGitEnv } from "../scripts/git-env.mjs";

test("only changes confined to docs/ and docs-site/ are documentation-only", () => {
  for (const files of [["docs-site/example-setup.html"], ["docs/EXAMPLE-GUIDE.md", "docs-site/assets/example.svg"], ["docs/releases/v0.0.0-example.md"]]) {
    assert.equal(classifyChange({ event: "push", files }).docs, true, files.join());
    assert.equal(classifyChange({ event: "pull_request", files }).docs, true, files.join());
  }
  for (const files of [
    ["docs-site/example-setup.html", "apps/api/src/index.ts"],
    [".github/workflows/docs.yml"],
    [".github/workflows/ci.yml", "docs/EXAMPLE-GUIDE.md"],
    ["scripts/ci-scope.mjs"],
    ["tests/docs-site.test.mjs", "docs-site/example-index.html"],
    ["README.md"],
    ["docs"],
    ["docs-sites/index.html"],
    ["package-lock.json", "docs/EXAMPLE-GUIDE.md"],
  ]) assert.equal(classifyChange({ event: "pull_request", files }).docs, false, files.join());
});

test("manual, scheduled, release, empty and unreadable changes always run complete scope", () => {
  const files = ["docs/EXAMPLE-GUIDE.md"];
  assert.equal(classifyChange({ event: "workflow_dispatch", files }).docs, false);
  assert.equal(classifyChange({ event: "schedule", files }).docs, false);
  assert.match(classifyChange({ event: "push", files, headMessage: "Release v2.0.1\n\nNotes" }).reason, /release commit/);
  assert.equal(classifyChange({ event: "push", files, headMessage: "Correct the kiosk wiring page" }).docs, true);
  assert.equal(classifyChange({ event: "push", files: [] }).docs, false);
  assert.equal(classifyChange({ event: "push", files: null }).docs, false);
});

test("documentation-only checks always include the docs-site suite and add tests that read a changed document", () => {
  const tests = new Map([
    [docsSiteTest, 'readFile(`docs-site/${page}`)'],
    ["tests/security.test.mjs", 'readFile("docs/EXAMPLE-RECOVERY.md")'],
    ["tests/foundation.test.mjs", 'readFile("docs/EXAMPLE-SECURITY.md")'],
    ["tests/kiosk-runtime.test.mjs", 'readFile("docs/EXAMPLE-GUIDE.md")'],
  ]);
  assert.deepEqual(selectDocsTests(["docs-site/example-setup.html"], tests), { tests: [docsSiteTest], install: false });
  assert.deepEqual(selectDocsTests(["docs/EXAMPLE-RECOVERY.md", "docs-site/example-index.html"], tests), { tests: [docsSiteTest, "tests/security.test.mjs"], install: true });
  // Device-only kiosk suites are left to the complete gate.
  assert.deepEqual(selectDocsTests(["docs/EXAMPLE-GUIDE.md"], tests).tests, [docsSiteTest]);
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
  const env = isolatedGitEnv(process.env, { GIT_AUTHOR_NAME: "Test Maintainer", GIT_AUTHOR_EMAIL: "maintainer@example.test", GIT_COMMITTER_NAME: "Test Maintainer", GIT_COMMITTER_EMAIL: "maintainer@example.test" });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const commit = (message) => { git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  write("apps/api/src/index.ts", "export {};\n");
  write("docs/EXAMPLE-GUIDE.md", "# Kiosk\n");
  write("docs-site/example-index.html", "<h1>Docs</h1>\n");
  write("tests/docs-site.test.mjs", "// docs-site/\n");
  write("tests/security.test.mjs", 'readFile("docs/EXAMPLE-GUIDE.md")\n');
  write(".github/workflows/ci.yml", "name: Verify\n");
  const base = commit("Initial");
  return { root, git, write, commit, base, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("pushes and pull requests read their changed files from git", () => {
  const repo = repository();
  try {
    const { root, write, commit, base, git } = repo;
    write("docs-site/example-index.html", "<h1>Corrected docs</h1>\n");
    const docsOnly = commit("Correct the docs home page");
    assert.deepEqual(scopeOutputs({ event: "push", base, head: docsOnly }, root), { docs: true, reason: "1 documentation file(s) changed", tests: [docsSiteTest], install: false });

    write("docs/EXAMPLE-GUIDE.md", "# Kiosk wiring\n");
    const kioskDoc = commit("Correct the kiosk guide");
    assert.deepEqual(scopeOutputs({ event: "push", base: docsOnly, head: kioskDoc }, root).tests, [docsSiteTest, "tests/security.test.mjs"]);

    write("apps/api/src/index.ts", "export const changed = true;\n");
    const mixed = commit("Change the API and docs");
    assert.equal(scopeOutputs({ event: "push", base, head: mixed }, root).docs, false);

    write(".github/workflows/ci.yml", "name: Verify changed\n");
    const workflow = commit("Change the workflow");
    assert.equal(scopeOutputs({ event: "push", base: mixed, head: workflow }, root).docs, false);

    // Moving an application file into docs/ still names its old path.
    renameSync(join(root, "apps/api/src/index.ts"), join(root, "docs/index.ts"));
    const moved = commit("Move a source file");
    assert.deepEqual(changedFiles({ event: "push", base: workflow, head: moved, root }).sort(), ["apps/api/src/index.ts", "docs/index.ts"]);
    assert.equal(scopeOutputs({ event: "push", base: workflow, head: moved }, root).docs, false);

    // A pull request is compared with its merge base: application commits on the base branch do not count against it.
    git("checkout", "-q", "-b", "docs-fix", moved);
    write("docs/EXAMPLE-GUIDE.md", "# Kiosk wiring, corrected\n");
    const branchHead = commit("Correct the kiosk guide again");
    git("checkout", "-q", "main");
    write("apps/api/src/other.ts", "export {};\n");
    const advancedBase = commit("Base branch application change");
    assert.equal(scopeOutputs({ event: "pull_request", base: advancedBase, head: branchHead }, root).docs, true);
    assert.equal(scopeOutputs({ event: "push", base: advancedBase, head: branchHead }, root).docs, false);

    // New branches, unknown commits and release commits run the usual scope.
    assert.equal(scopeOutputs({ event: "push", base: "0000000000000000000000000000000000000000", head: docsOnly }, root).reason, "changed files could not be determined");
    assert.equal(scopeOutputs({ event: "push", base: "1111111111111111111111111111111111111111", head: docsOnly }, root).docs, false);
    assert.equal(scopeOutputs({ event: "push", base, head: docsOnly, "head-message": "Release v2.0.1" }, root).docs, false);
    assert.equal(scopeOutputs({ event: "workflow_dispatch", base, head: docsOnly }, root).docs, false);
  } finally { repo.cleanup(); }
});

test("Verify keeps its required jobs and runs only documentation checks for a documentation-only change", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
  const verify = ci.match(/\n  verify:\n([\s\S]*?)\n  [a-z-]+:\n/)?.[1];
  assert.ok(verify);
  // Scope is selected before the install so a documentation-only change can skip it.
  assert.ok(verify.indexOf("name: Select verification scope") < verify.indexOf("run: npm ci --no-audit"));
  assert.match(verify, /node scripts\/ci-scope\.mjs --event "\$GITHUB_EVENT_NAME" --base "\$docs_base" --head "\$HEAD_SHA" --head-message "\$HEAD_COMMIT_MESSAGE"/);
  assert.match(verify, /run: npm ci --no-audit\n\s+if: steps\.verification-scope\.outputs\.docs != 'true' \|\| steps\.verification-scope\.outputs\.docs-install == 'true'/);
  assert.match(verify, /installer runs\n\s+if: steps\.verification-scope\.outputs\.docs != 'true'\n/);
  assert.match(verify, /name: Run documentation-only verification\n\s+if: steps\.verification-scope\.outputs\.docs == 'true'[\s\S]*node --test "\$\{docs_tests\[@\]\}"/);
  for (const command of ["npm run verify:dev", "npm run verify:kiosk"]) {
    const step = verify.split("      - ").find((chunk) => chunk.includes(command));
    assert.match(step, /if: steps\.verification-scope\.outputs\.docs != 'true' && /, command);
  }
  // Complete verification (dispatch) never consults the documentation scope.
  assert.match(verify, /docs=false\n\s+if \[\[ "\$full" != "true" \]\]; then/);
  assert.match(verify, /"\$GITHUB_EVENT_NAME" == "workflow_dispatch" \]\]; then\n\s+full=true/);
});
