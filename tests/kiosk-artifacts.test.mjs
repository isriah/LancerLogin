import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { checkKioskArchiveModes, kioskArchitectures, packageKioskArtifacts, smokeKioskDirectory, verifyKioskArtifacts, writeKioskArchive } from "../scripts/package-kiosk.mjs";

function archiveWithMode(archive, path, mode) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "").replace(/^\.\//, "").replace(/\/$/, "") || ".";
    if (name === path) {
      header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
      header.fill(32, 148, 156);
      header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
      return gzipSync(tar);
    }
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8);
    if (!Number.isFinite(size)) break;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Test archive entry missing: ${path}`);
}

test("Linux installer replaces an older root helper with verified packaged bytes and permissions", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-installed-helper-"));
  try {
    const version = "0.24.0";
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version });
    const extracted = join(scratch, "opt/lancerlogin");
    const installed = join(scratch, "usr/local/sbin/lancerlogin-install-release");
    await mkdir(extracted, { recursive: true });
    await mkdir(join(scratch, "usr/local/sbin"), { recursive: true });
    execFileSync("tar", ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`), "-C", extracted]);
    await writeFile(installed, "#!/bin/bash\n# older v0-only installed helper\n", { mode: 0o700 });
    const installer = await readFile(join(artifacts, "install-lancerlogin.sh"), "utf8");
    const start = installer.indexOf("install -m 0755 /opt/lancerlogin/scripts/lancerlogin-install-release.sh");
    const end = installer.indexOf("install -d -m 0755 /etc/polkit-1/rules.d", start);
    assert.ok(start > 0 && end > start);
    // Execute the actual packaged installer block, changing only filesystem
    // roots to an isolated directory. Real install/cmp/stat prove replacement.
    const block = installer.slice(start, end).replaceAll("/opt/lancerlogin", extracted).replaceAll("/usr/local/sbin/lancerlogin-install-release", installed);
    execFileSync("/usr/bin/bash", ["-euc", block]);
    assert.equal(await readFile(installed, "utf8"), await readFile(join(extracted, "scripts/lancerlogin-install-release.sh"), "utf8"));
    assert.equal(execFileSync("stat", ["-c", "%U:%G:%a", installed], { encoding: "utf8" }).trim(), "root:root:755");
    assert.throws(() => execFileSync("/usr/bin/bash", [installed, "v9.9.9"], { stdio: "pipe" }), error => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /accepts no arguments/);
      return true;
    });
    // Corrupting the installed helper after copy must fail verification.
    const verification = block.slice(block.indexOf("cmp --silent"));
    await writeFile(installed, "corrupted");
    assert.throws(() => execFileSync("/usr/bin/bash", ["-euc", verification], { stdio: "pipe" }));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("Linux in-place installer preserves protected pairing, mappings and offline queue bytes", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-retained-state-"));
  try {
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version: "9.9.9" });
    const runtime = join(scratch, "runtime"); const state = join(scratch, "state");
    await mkdir(runtime); await mkdir(state, { mode: 0o700 });
    const retained = { "pairing.json": '{"kioskToken":"synthetic-retained-token"}', "mappings.json": '{"107":"SYN-001"}', "queue.json": '[{"eventId":"synthetic-before-upgrade","memberId":"SYN-001","occurredAt":"2026-10-01T10:00:00Z"}]', "network-pin.json": '{"hash":"synthetic-retained-hash"}' };
    for (const [name, bytes] of Object.entries(retained)) await writeFile(join(state, name), bytes, { mode: 0o600 });
    const installer = await readFile(join(artifacts, "install-lancerlogin.sh"), "utf8");
    const normalize = installer.slice(installer.indexOf("normalize_runtime_permissions()"), installer.indexOf("check_hardware()"));
    const start = installer.indexOf("install -d -m 0755 -o root -g root /opt/lancerlogin");
    const end = installer.indexOf("install -m 0644 /opt/lancerlogin/systemd", start);
    assert.ok(start > 0 && end > start);
    // Execute real installation/extraction commands with isolated filesystem
    // roots and root as the test state owner. No service or hardware calls.
    const block = (normalize + installer.slice(start, end)).replaceAll("/opt/lancerlogin", runtime).replaceAll("/var/lib/lancerlogin", state).replaceAll("-o lancerlogin -g lancerlogin", "-o root -g root");
    execFileSync("/usr/bin/bash", ["-euc", block], { env: { ...process.env, temporary: artifacts, archive: "lancerlogin-kiosk-9.9.9-linux-arm64.tar.gz" } });
    for (const [name, bytes] of Object.entries(retained)) {
      assert.equal(await readFile(join(state, name), "utf8"), bytes);
      assert.equal(execFileSync("stat", ["-c", "%a", join(state, name)], { encoding: "utf8" }).trim(), "600");
    }
    assert.equal(execFileSync("stat", ["-c", "%a", state], { encoding: "utf8" }).trim(), "700");
    assert.equal(execFileSync("stat", ["-c", "%a", runtime], { encoding: "utf8" }).trim(), "755");
    assert.match(installer, /Enter a dashboard one-time pairing key only if the kiosk shows the pairing screen/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("both shipped archives load and serve their isolated runtime; missing imports fail closed", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-artifact-test-"));
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  try {
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version });
    for (const arch of kioskArchitectures) {
      const extracted = join(scratch, arch);
      await mkdir(extracted);
      execFileSync("tar", ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`), "-C", extracted]);
      checkKioskArchiveModes(await readFile(join(artifacts, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`)));
      const expected = [...(await readdir("apps/kiosk/src")).filter(name => name.endsWith(".mjs")), "release-policy.mjs"].sort();
      assert.deepEqual((await readdir(join(extracted, "src"))).sort(), expected);
      assert.equal(await readFile(join(extracted, "src/release-policy.mjs"), "utf8"), await readFile("packages/shared/src/release-policy.mjs", "utf8"));
      for (const missing of ["update-command.mjs", "kiosk-presentation.mjs", "release-policy.mjs", "resolve-kiosk-release.mjs"]) {
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
    await writeKioskArchive(broken, join(artifacts, name));
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
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
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


test("valid-checksum archives with inaccessible or writable code fail permission validation on every host", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-mode-test-"));
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  try {
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version });
    const name = `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`;
    const good = await readFile(join(artifacts, name));
    for (const [path, mode] of [[".", 0o700], ["src", 0o700], ["src/service.mjs", 0o600], ["src", 0o777], ["src/service.mjs", 0o666], ["scripts/lancerlogin-install-release.sh", 0o644]]) {
      await writeFile(join(artifacts, name), archiveWithMode(good, path, mode));
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
    // Exercise the actual installer repair, including permissive Windows modes.
    await chmod(join(extracted, "src"), 0o777);
    await chmod(join(extracted, "src/service.mjs"), 0o666);
    await chmod(join(extracted, "scripts/lancerlogin-install-release.sh"), 0o666);
    const installer = await readFile("apps/kiosk/scripts/install-lancerlogin.sh", "utf8");
    const repair = installer.match(/^chmod 0755 \/opt\/lancerlogin$/m)?.[0];
    const normalize = installer.match(/^normalize_runtime_permissions\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(repair && normalize);
    const repairBlock = `${normalize}\n${repair}\nnormalize_runtime_permissions`.replaceAll("/opt/lancerlogin", extracted);
    execFileSync("bash", ["-euc", repairBlock]);
    for (const [path, mode] of [[".", "755"], ["src", "755"], ["src/service.mjs", "644"], ["scripts/lancerlogin-install-release.sh", "755"]]) {
      assert.equal(execFileSync("stat", ["-c", "%a", join(extracted, path)], { encoding: "utf8" }).trim(), mode);
    }
    await smokeKioskDirectory(extracted, { requireUnprivileged: true });
    for (const [create, message] of [[symlink, /Unexpected runtime file type/], [link, /Unexpected runtime hard link/]]) {
      const unexpected = join(extracted, "unexpected-link");
      await create(join(extracted, "src/service.mjs"), unexpected);
      assert.throws(() => execFileSync("bash", ["-euc", repairBlock], { stdio: "pipe" }), error => {
        assert.match(String(error.stderr), message); return true;
      });
      await rm(unexpected);
    }
  } finally {
    await rm(extracted, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Linux CI mandates the distinct-account artifact regression gate", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /run: sudo "\$\(command -v node\)" --test tests\/kiosk-artifacts\.test\.mjs/);
});
