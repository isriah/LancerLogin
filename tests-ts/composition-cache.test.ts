// The shared test composition cache (tests-ts/fixtures/composed-plugins.ts): keys follow every pin and composer input, and
// concurrent test processes never see a partial or stale composition.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedDirectory, composerInputs, compositionCacheKey } from "./fixtures/composed-plugins.ts";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));
const scratch = () => { const directory = mkdtempSync(join(tmpdir(), "lancerlogin-composition-cache-")); test.after(() => rmSync(directory, { recursive: true, force: true })); return directory; };
const selection = (commit: string, source = "https://github.com/isriah/lancerlogin-outreach.git") => JSON.stringify({ format: 1, modules: [{ id: "hour-tracking", source, commit }] });

test("the composer inputs cover the composer, its import closure, Core migrations and package versions", () => {
  const inputs = composerInputs().map((file) => relative(coreRoot, file).replaceAll("\\", "/"));
  for (const file of ["scripts/compose-modules.mjs", "scripts/inspect-module-plugin.mjs", "scripts/test-plugin-sources.mjs", "scripts/git-env.mjs", "apps/api/src/module-migrations.ts", "packages/shared/src/module-platform.ts", "packages/shared/src/module-selection.ts", "tests-ts/fixtures/composed-plugins.ts", "package.json", "package-lock.json", "packages/module-sdk/package.json"]) assert.ok(inputs.includes(file), file);
  assert.ok(inputs.some((file) => /^apps\/api\/migrations\/0001_/.test(file)));
});

test("a composition key changes with any pin and any composer input, and only then", () => {
  const root = scratch();
  mkdirSync(join(root, "scripts"), { recursive: true }); mkdirSync(join(root, "apps/api/migrations"), { recursive: true });
  writeFileSync(join(root, "scripts/compose-modules.mjs"), 'import { helper } from "./helper.mjs";\n');
  writeFileSync(join(root, "scripts/helper.mjs"), "export const helper = 1;\n");
  writeFileSync(join(root, "apps/api/migrations/0001_initial.sql"), "CREATE TABLE members (id TEXT);\n");
  writeFileSync(join(root, "package.json"), '{ "version": "2.1.0" }\n');
  const args = (commit: string, source?: string) => ["--selection", selection(commit, source), "--test-allow-file-sources"];
  const base = compositionCacheKey(args("a".repeat(40)), root);
  assert.equal(compositionCacheKey(args("a".repeat(40)), root), base);
  const keys = [
    compositionCacheKey(args("b".repeat(40)), root),
    compositionCacheKey(args("a".repeat(40), "file:///C:/plugins/lancerlogin-outreach"), root),
    compositionCacheKey(["--selection", selection("a".repeat(40)), "--test-allow-file-sources", "--no-official-modules"], root),
  ];
  writeFileSync(join(root, "scripts/helper.mjs"), "export const helper = 2;\n");
  keys.push(compositionCacheKey(args("a".repeat(40)), root));
  writeFileSync(join(root, "apps/api/migrations/0002_next.sql"), "CREATE TABLE events (id TEXT);\n");
  keys.push(compositionCacheKey(args("a".repeat(40)), root));
  writeFileSync(join(root, "package.json"), '{ "version": "2.1.1" }\n');
  keys.push(compositionCacheKey(args("a".repeat(40)), root));
  assert.equal(new Set([base, ...keys]).size, keys.length + 1);
});

test("a cached directory is built once, reused, and rebuilt when its marker or contents are wrong", () => {
  const root = scratch(); let builds = 0;
  const build = (directory: string) => { builds++; writeFileSync(join(directory, "result.txt"), `build ${builds}`); };
  const complete = (directory: string) => existsSync(join(directory, "result.txt"));
  const key = "c".repeat(64);
  const first = cachedDirectory({ root, key, build, complete });
  assert.equal(cachedDirectory({ root, key, build, complete }), first);
  assert.equal(builds, 1);
  rmSync(join(first, "result.txt"));
  assert.equal(cachedDirectory({ root, key, build, complete }), first);
  assert.equal(readFileSync(join(first, "result.txt"), "utf8"), "build 2");
  // An entry whose recorded key differs (a truncated-key collision) is never reused.
  const collision = `${key.slice(0, 32)}${"d".repeat(32)}`;
  assert.equal(cachedDirectory({ root, key: collision, build, complete }), first);
  assert.equal(readFileSync(join(first, "result.txt"), "utf8"), "build 3");
  assert.throws(() => cachedDirectory({ root, key: "e".repeat(64), build: () => { throw new Error("composition failed"); }, complete }), /composition failed/);
  assert.deepEqual(readdirSync(root).sort(), [key.slice(0, 32)]);
});

test("a process that loses the rename race uses the winner's entry and discards its own build", () => {
  const root = scratch(); const key = "f".repeat(64); const entry = join(root, key.slice(0, 32));
  const complete = (directory: string) => existsSync(join(directory, "result.txt"));
  const result = cachedDirectory({ root, key, complete, build: (directory) => {
    writeFileSync(join(directory, "result.txt"), "loser");
    // Another process completes the same key while this one is still building.
    mkdirSync(entry); writeFileSync(join(entry, "result.txt"), "winner"); writeFileSync(join(entry, "lancerlogin-composition.json"), JSON.stringify({ key }));
  } });
  assert.equal(result, entry);
  assert.equal(readFileSync(join(entry, "result.txt"), "utf8"), "winner");
  assert.deepEqual(readdirSync(root), [key.slice(0, 32)]);
});

test("concurrent test processes agree on one complete entry", async () => {
  const root = scratch(); const key = "0".repeat(64);
  const fixture = new URL("./fixtures/composed-plugins.ts", import.meta.url).href;
  const script = `import { cachedDirectory } from ${JSON.stringify(fixture)}; import { existsSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const directory = cachedDirectory({ root: ${JSON.stringify(root)}, key: ${JSON.stringify(key)}, complete: (d) => existsSync(join(d, "a.txt")) && existsSync(join(d, "b.txt")), build: (d) => { writeFileSync(join(d, "a.txt"), String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); writeFileSync(join(d, "b.txt"), String(process.pid)); } });
process.stdout.write(directory);`;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = ""; child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`child exited ${code}`)));
  });
  const directories = await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(new Set(directories), new Set([join(root, key.slice(0, 32))]));
  assert.equal(readFileSync(join(directories[0]!, "a.txt"), "utf8"), readFileSync(join(directories[0]!, "b.txt"), "utf8"));
  assert.deepEqual(readdirSync(root), [key.slice(0, 32)]);
});
