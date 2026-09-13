import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kioskArchitectures, packageKioskArtifacts, smokeKioskDirectory, verifyKioskArtifacts } from "../scripts/package-kiosk.mjs";

test("both shipped archives load and serve their isolated runtime; missing imports fail closed", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-artifact-test-"));
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  try {
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version });
    for (const arch of kioskArchitectures) {
      const extracted = join(scratch, arch);
      await mkdir(extracted);
      execFileSync("tar", ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`), "-C", extracted]);
      const expected = (await readdir("apps/kiosk/src")).filter(name => name.endsWith(".mjs")).sort();
      assert.deepEqual((await readdir(join(extracted, "src"))).sort(), expected);
      for (const missing of ["update-command.mjs", "kiosk-presentation.mjs"]) {
        // Re-extract between failures so each missing direct/transitive import is tested alone.
        execFileSync("tar", ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`), "-C", extracted]);
        await rm(join(extracted, "src", missing));
        await assert.rejects(smokeKioskDirectory(extracted), error => {
          assert.match(String(error.stderr), /ERR_MODULE_NOT_FOUND/);
          assert.ok(String(error.stderr).includes(missing));
          return true;
        });
      }
    }
    // Repackage a broken archive with a valid checksum: validation must detect
    // the missing import, not merely a corrupted download.
    const broken = join(scratch, "arm64");
    const name = `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`;
    execFileSync("tar", ["-xzf", join(artifacts, name), "-C", broken]);
    await rm(join(broken, "src/update-command.mjs"));
    execFileSync("tar", ["-czf", join(artifacts, name), "-C", broken, "."]);
    const digest = createHash("sha256").update(await readFile(join(artifacts, name))).digest("hex");
    await writeFile(join(artifacts, `${name}.sha256`), `${digest}  ${name}\n`);
    await assert.rejects(verifyKioskArtifacts({ artifacts, version }), error => {
      assert.match(String(error.stderr), /ERR_MODULE_NOT_FOUND/);
      assert.match(String(error.stderr), /update-command\.mjs/);
      return true;
    });
    // A separately built good set must also reject a missing checksum file.
    const fresh = await packageKioskArtifacts({ output: join(scratch, "fresh"), version });
    await rm(join(fresh, "install-lancerlogin.sh.sha256"));
    await assert.rejects(verifyKioskArtifacts({ artifacts: fresh, version }), /ENOENT/);
    await assert.rejects(packageKioskArtifacts({ output: artifacts, version }), /EEXIST/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("release publication requires shared artifact validation after exact-commit CI", async () => {
  const workflow = await readFile(".github/disabled-workflows/release.yml", "utf8");
  assert.match(workflow, /if: \$\{\{ false \}\}/);
  const gate = workflow.indexOf('run: sudo "$(command -v node)" scripts/package-kiosk.mjs release/artifacts --require-unprivileged');
  assert.ok(gate > workflow.indexOf("successful_runs="));
  assert.ok(gate < workflow.indexOf("gh release create"));
  assert.doesNotMatch(workflow, /continue-on-error|if: always\(\)|cp apps\/kiosk\/src/);
  assert.match(workflow, /actions\/setup-node@/);
  assert.match(workflow, /GITHUB_REF_NAME.*v\$package_version/);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(manifest.scripts["test:kiosk"], /tests\/kiosk-artifacts\.test\.mjs/);
  assert.match(manifest.scripts.test, /tests\/\*\*\/\*\.test\.mjs/);
});


test("valid-checksum archives with inaccessible code fail permission validation", { skip: process.platform === "win32" }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-mode-test-"));
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  try {
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version });
    const name = `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`;
    const good = await readFile(join(artifacts, name));
    const extracted = join(scratch, "extracted");
    await mkdir(extracted);
    for (const [path, mode] of [[".", 0o700], ["src", 0o700], ["src/service.mjs", 0o600]]) {
      await writeFile(join(artifacts, name), good);
      execFileSync("tar", ["-xzf", join(artifacts, name), "-C", extracted]);
      await chmod(join(extracted, path), mode);
      execFileSync("tar", ["-czf", join(artifacts, name), "-C", extracted, "."]);
      const digest = createHash("sha256").update(await readFile(join(artifacts, name))).digest("hex");
      await writeFile(join(artifacts, `${name}.sha256`), `${digest}  ${name}\n`);
      await assert.rejects(verifyKioskArtifacts({ artifacts, version }), /Unsafe kiosk artifact mode/);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("Linux root-owned artifacts start as another account, and mode 700 actually blocks it", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-identity-test-"));
  const extracted = await mkdtemp(join(tmpdir(), "lancerlogin-identity-runtime-"));
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  try {
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version, requireUnprivileged: true });
    execFileSync("tar", ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`), "-C", extracted]);
    await chmod(extracted, 0o700);
    await assert.rejects(smokeKioskDirectory(extracted, { requireUnprivileged: true }), error => {
      assert.match(String(error.stderr), /EACCES/);
      return true;
    });
    // Exercise the installer's exact post-extraction repair on a disposable path.
    const installer = await readFile("apps/kiosk/scripts/install-lancerlogin.sh", "utf8");
    const repair = installer.match(/^chmod 0755 \/opt\/lancerlogin$/m)?.[0];
    assert.ok(repair);
    execFileSync("bash", ["-c", repair.replace("/opt/lancerlogin", '\"$1\"'), "repair-test", extracted]);
    await smokeKioskDirectory(extracted, { requireUnprivileged: true });
  } finally {
    await rm(extracted, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Linux CI mandates the distinct-account artifact regression gate", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /run: sudo "\$\(command -v node\)" --test tests\/kiosk-artifacts\.test\.mjs/);
});
