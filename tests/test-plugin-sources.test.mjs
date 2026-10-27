import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareTestComposition, resolveTestPin } from "../scripts/test-plugin-sources.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};

test("private plugin pins use the token, then a local checkout of the pinned commit, and otherwise name what is missing", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "lancerlogin-plugin-sources-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "core"); mkdirSync(join(root, "scripts"), { recursive: true });
  const checkout = join(scratch, "checkouts", "lancerlogin-example"); mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet"); writeFileSync(join(checkout, "README.md"), "synthetic\n"); git(checkout, "add", "-A"); git(checkout, "commit", "--quiet", "-m", "Synthetic");
  const commit = git(checkout, "rev-parse", "HEAD");
  const pin = { id: "example", source: "https://github.com/example-owner/lancerlogin-example.git", commit };
  const bare = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };

  const missing = resolveTestPin(pin, { env: bare, root });
  assert.match(missing.reason, /pinned to private https:\/\/github\.com\/example-owner\/lancerlogin-example\.git at [0-9a-f]{40}\. Set LANCERLOGIN_PLUGIN_TOKEN/);
  assert.match(missing.reason, /local checkout named lancerlogin-example/);
  assert.deepEqual(resolveTestPin(pin, { env: { ...bare, LANCERLOGIN_PLUGIN_TOKEN: "synthetic" }, root }), { pin, via: "token" });
  const local = resolveTestPin(pin, { env: { ...bare, LANCERLOGIN_PLUGIN_CHECKOUTS: join(scratch, "checkouts") }, root });
  assert.deepEqual(local, { pin: { ...pin, source: pathToFileURL(checkout).href }, via: "local" });
  assert.match(resolveTestPin({ ...pin, commit: "f".repeat(40) }, { env: { ...bare, LANCERLOGIN_PLUGIN_CHECKOUTS: join(scratch, "checkouts") }, root }).reason, /Set LANCERLOGIN_PLUGIN_TOKEN/, "a checkout without the pinned commit is not used");

  // A plugin repository's CI overrides the plugin under test; half an override is refused.
  const override = { LANCERLOGIN_EXAMPLE_PLUGIN_SOURCE: pathToFileURL(checkout).href, LANCERLOGIN_EXAMPLE_PLUGIN_COMMIT: commit };
  assert.equal(resolveTestPin(pin, { env: { ...bare, ...override }, root }).via, "override");
  assert.match(resolveTestPin(pin, { env: { ...bare, LANCERLOGIN_EXAMPLE_PLUGIN_COMMIT: commit }, root }).reason, /Set both LANCERLOGIN_EXAMPLE_PLUGIN_SOURCE and LANCERLOGIN_EXAMPLE_PLUGIN_COMMIT/);
  assert.match(resolveTestPin({ ...pin, id: "hour-tracking" }, { env: { ...bare, LANCERLOGIN_OUTREACH_PLUGIN_SOURCE: "x" }, root }).reason, /LANCERLOGIN_OUTREACH_PLUGIN_COMMIT/);

  // Official pins resolve the same way; an override of an official module replaces its pin through the selection.
  writeFileSync(join(root, "scripts", "official-modules.json"), JSON.stringify({ format: 1, status: "active", modules: [pin] }));
  assert.match(prepareTestComposition({ env: bare, root, scratch }).reason, /Set LANCERLOGIN_PLUGIN_TOKEN/);
  const prepared = prepareTestComposition({ env: { ...bare, ...override }, root, scratch });
  assert.deepEqual(prepared.modules, [{ ...pin, source: pathToFileURL(checkout).href }]);
  assert.deepEqual(prepared.args.filter((arg) => arg.startsWith("--")), ["--selection", "--test-allow-file-sources", "--official-list"]);
  assert.equal(prepared.env.LANCERLOGIN_PLUGIN_TOKEN, "");
  assert.deepEqual(prepareTestComposition({ env: bare, root, scratch, officialModules: false }).args.at(-1), "--no-official-modules");
});
