import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareTestComposition, resolveTestPin, unreachablePinAdvice } from "../scripts/test-plugin-sources.mjs";
import { fetchCommit } from "./fixtures/official-plugin-source.mjs";
import { isolatedGitEnv } from "../scripts/git-env.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: isolatedGitEnv() });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};

test("https plugin pins use the token, then a local checkout of the pinned commit, and otherwise an anonymous fetch", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-plugin-sources-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "core"); mkdirSync(join(root, "scripts"), { recursive: true });
  const checkout = join(scratch, "checkouts", "lancerlogin-example"); mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet"); writeFileSync(join(checkout, "README.md"), "synthetic\n"); git(checkout, "add", "-A"); git(checkout, "commit", "--quiet", "-m", "Synthetic");
  const commit = git(checkout, "rev-parse", "HEAD");
  const pin = { id: "example", source: "https://github.com/example-owner/lancerlogin-example.git", commit };
  const bare = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };

  // Without a token or a local checkout, the public repository is fetched anonymously.
  assert.deepEqual(resolveTestPin(pin, { env: bare, root }), { pin, via: "anonymous" });
  const advice = unreachablePinAdvice(pin, { env: bare, root });
  assert.match(advice, /If https:\/\/github\.com\/example-owner\/lancerlogin-example\.git is private, set LANCERLOGIN_PLUGIN_TOKEN/);
  assert.match(advice, /local checkout named lancerlogin-example containing [0-9a-f]{40}/);
  assert.deepEqual(resolveTestPin(pin, { env: { ...bare, LANCERLOGIN_PLUGIN_TOKEN: "synthetic" }, root }), { pin, via: "token" });
  const local = resolveTestPin(pin, { env: { ...bare, LANCERLOGIN_PLUGIN_CHECKOUTS: join(scratch, "checkouts") }, root });
  assert.deepEqual(local, { pin: { ...pin, source: pathToFileURL(checkout).href }, via: "local" });
  assert.equal(resolveTestPin({ ...pin, commit: "f".repeat(40) }, { env: { ...bare, LANCERLOGIN_PLUGIN_CHECKOUTS: join(scratch, "checkouts") }, root }).via, "anonymous", "a checkout without the pinned commit is not used");
  assert.match(resolveTestPin({ ...pin, commit: "main" }, { env: bare, root }).reason, /not a full commit SHA/);

  // A plugin repository's CI overrides the plugin under test; half an override is refused.
  const override = { LANCERLOGIN_EXAMPLE_PLUGIN_SOURCE: pathToFileURL(checkout).href, LANCERLOGIN_EXAMPLE_PLUGIN_COMMIT: commit };
  assert.equal(resolveTestPin(pin, { env: { ...bare, ...override }, root }).via, "override");
  assert.match(resolveTestPin(pin, { env: { ...bare, LANCERLOGIN_EXAMPLE_PLUGIN_COMMIT: commit }, root }).reason, /Set both LANCERLOGIN_EXAMPLE_PLUGIN_SOURCE and LANCERLOGIN_EXAMPLE_PLUGIN_COMMIT/);
  assert.match(resolveTestPin({ ...pin, id: "hour-tracking" }, { env: { ...bare, LANCERLOGIN_OUTREACH_PLUGIN_SOURCE: "x" }, root }).reason, /LANCERLOGIN_OUTREACH_PLUGIN_COMMIT/);

  // Official pins resolve the same way; an override of an official module replaces its pin through the selection.
  writeFileSync(join(root, "scripts", "official-modules.json"), JSON.stringify({ format: 1, status: "active", modules: [pin] }));
  const anonymous = prepareTestComposition({ env: bare, root, scratch });
  assert.deepEqual(anonymous.modules, [pin]);
  assert.equal(anonymous.env.LANCERLOGIN_PLUGIN_TOKEN, "");
  const prepared = prepareTestComposition({ env: { ...bare, ...override }, root, scratch });
  assert.deepEqual(prepared.modules, [{ ...pin, source: pathToFileURL(checkout).href }]);
  assert.deepEqual(prepared.args.filter((arg) => arg.startsWith("--")), ["--selection", "--test-allow-file-sources", "--official-list"]);
  assert.equal(prepared.env.LANCERLOGIN_PLUGIN_TOKEN, "");
  assert.deepEqual(prepareTestComposition({ env: bare, root, scratch, officialModules: false }).args.at(-1), "--no-official-modules");
});

test("an official plugin source fetch is anonymous without a token and keeps a token out of the URL and errors", () => {
  const recorded = [];
  const original = process.env.PATH;
  // A failing fetch from an unreachable host: the error must not contain the token or its header value.
  const token = "synthetic-plugin-token-value";
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  for (const environment of [{ PATH: original, SystemRoot: process.env.SystemRoot }, { PATH: original, SystemRoot: process.env.SystemRoot, LANCERLOGIN_PLUGIN_TOKEN: token }]) {
    try { fetchCommit("https://invalid.example.invalid/owner/plugin.git", "a".repeat(40), environment); assert.fail("the fetch should fail"); }
    catch (error) { recorded.push(String(error.message)); }
  }
  for (const message of recorded) {
    assert.match(message, /Unable to fetch https:\/\/invalid\.example\.invalid\/owner\/plugin\.git at a{40}/);
    assert.equal(message.includes(token) || message.includes(encoded), false);
  }
});
