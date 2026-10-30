import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { copyFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { checkKioskArchiveModes, kioskArchitectures, packageKioskArtifacts, smokeKioskDirectory, verifyKioskArtifacts, writeKioskArchive } from "../scripts/package-kiosk.mjs";
import { findTar, requireTool, toolSkip } from "./fixtures/host-tools.mjs";

// The test's own tar calls use a tar that handles absolute host paths; scripts/package-kiosk.mjs picks its own (tarCommand).
const tar = findTar();

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

// Run real installer function definitions and install blocks with every filesystem root moved into a
// disposable directory. systemctl, ss, journalctl and the health probe are stubs; no service or device is touched.
function installerHarness(installer, root) {
  const definitions = installer.slice(installer.indexOf("architecture() {"), installer.indexOf('if [[ "$MODE" == "--dry-run" ]]; then'));
  const pattern = installer.match(/^RELEASE_NAME_PATTERN=.*$/m)?.[0];
  assert.ok(definitions.length > 100 && pattern);
  return `set -euo pipefail
ROOT=${JSON.stringify(root)}
RUNTIME_ROOT="$ROOT/opt/lancerlogin"
RELEASES_DIR="$RUNTIME_ROOT/releases"
STATE_ROOT="$ROOT/var/lib/lancerlogin"
UNIT_DIR="$ROOT/etc/systemd/system"
DROPIN_DIR="$UNIT_DIR/lancerlogin-kiosk.service.d"
POLKIT_DIR="$ROOT/etc/polkit-1/rules.d"
HELPER_PATH="$ROOT/usr/local/sbin/lancerlogin-install-release"
LAUNCHER_PATH="$ROOT/usr/local/bin/lancerlogin-open-kiosk"
NODE="$ROOT/node"
HEALTH_URL=http://127.0.0.1:9/health
HEALTH_ATTEMPTS=3
${pattern}
${definitions}
systemctl() { printf '%s\\n' "$*" >> "$ROOT/systemctl.log"; case "$1" in is-active) [[ -e "$ROOT/active" ]] ;; start | restart) : > "$ROOT/active" ;; stop) rm -f -- "$ROOT/active" ;; esac; }
ss() { return 0; }
journalctl() { return 0; }
sleep() { :; }
kiosk_healthy() { [[ -e "$ROOT/active" ]] && ! grep -q BROKEN "$RUNTIME_ROOT/current/src/service.mjs"; }
`;
}
// Node for the installer's syntax and unprivileged import checks. The root-only drop-in cleaner is recorded, not run.
async function writeNodeWrapper(root) {
  await writeFile(join(root, "node"), `#!/bin/sh
case "$1" in */clean-version-overrides.mjs) printf '%s\n' "$1" >> ${JSON.stringify(join(root, "clean.log"))}; exit 0 ;; esac
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o755 });
}

test("Linux installer replaces an older root helper with verified packaged bytes and permissions", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-installed-helper-"));
  try {
    const version = "0.24.0";
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version });
    const extracted = join(scratch, "release");
    const runtime = join(scratch, "opt/lancerlogin");
    const installed = join(scratch, "usr/local/sbin/lancerlogin-install-release");
    await mkdir(extracted, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await mkdir(join(scratch, "usr/local/sbin"), { recursive: true });
    await symlink(extracted, join(runtime, "current"));
    execFileSync(tar.path, ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`), "-C", extracted]);
    await writeFile(installed, "#!/bin/bash\n# older v0-only installed helper\n", { mode: 0o700 });
    const installer = await readFile(join(artifacts, "install-lancerlogin.sh"), "utf8");
    const start = installer.indexOf('install_atomic 0755 "$RUNTIME_ROOT/current/scripts/lancerlogin-install-release.sh" "$HELPER_PATH"');
    const end = installer.indexOf('install -d -m 0755 "$POLKIT_DIR"', start);
    assert.ok(start > 0 && end > start);
    // Execute the actual packaged installer block, changing only filesystem
    // roots to an isolated directory. Real install/cmp/stat prove replacement.
    const block = installerHarness(installer, scratch) + installer.slice(start, end);
    execFileSync("/usr/bin/bash", ["-c", block]);
    assert.equal(await readFile(installed, "utf8"), await readFile(join(extracted, "scripts/lancerlogin-install-release.sh"), "utf8"));
    assert.equal(execFileSync("stat", ["-c", "%U:%G:%a", installed], { encoding: "utf8" }).trim(), "root:root:755");
    assert.throws(() => execFileSync("/usr/bin/bash", [installed, "v9.9.9"], { stdio: "pipe" }), error => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /accepts no arguments/);
      return true;
    });
    // Corrupting the installed helper after copy must fail verification.
    const verification = installerHarness(installer, scratch) + installer.slice(installer.indexOf("cmp --silent", start), end);
    await writeFile(installed, "corrupted");
    assert.throws(() => execFileSync("/usr/bin/bash", ["-c", verification], { stdio: "pipe" }));

    const launcher = join(scratch, "usr/local/bin/lancerlogin-open-kiosk");
    await mkdir(join(scratch, "usr/local/bin"));
    await writeFile(launcher, "#!/bin/bash\n# old shared-profile launcher\n", { mode: 0o700 });
    const launcherStart = installer.indexOf('  install_atomic 0755 "$RUNTIME_ROOT/current/scripts/lancerlogin-open-kiosk.sh" /usr/local/bin/lancerlogin-open-kiosk');
    const launcherEnd = installer.indexOf("  install -d -m 0755 /etc/xdg/autostart", launcherStart);
    assert.ok(launcherStart > 0 && launcherEnd > launcherStart);
    const launcherBlock = installerHarness(installer, scratch) + installer.slice(launcherStart, launcherEnd).replaceAll("/usr/local/bin/lancerlogin-open-kiosk", launcher);
    execFileSync("/usr/bin/bash", ["-c", launcherBlock]);
    assert.equal(await readFile(launcher, "utf8"), await readFile(join(extracted, "scripts/lancerlogin-open-kiosk.sh"), "utf8"));
    assert.equal(execFileSync("stat", ["-c", "%U:%G:%a", launcher], { encoding: "utf8" }).trim(), "root:root:755");
    assert.throws(() => execFileSync("/usr/bin/bash", [launcher, "unexpected"], { stdio: "pipe" }), error => {
      assert.equal(error.status, 2); assert.match(String(error.stderr), /accepts no arguments/); return true;
    });
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("Linux installer replaces old desktop shortcuts with links to installed applications", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-desktop-entry-"));
  try {
    const installer = (await readFile("apps/kiosk/scripts/install-lancerlogin.sh", "utf8")).replaceAll("\r\n", "\n");
    const start = installer.indexOf("  install -d -m 0755 /usr/local/share/applications");
    const end = installer.indexOf('  echo "Chromium will open', start);
    assert.ok(start > 0 && end > start);
    const home = join(scratch, "home"), applications = join(scratch, "applications");
    const desktop = join(home, "Desktop/LancerLogin Kiosk.desktop");
    await mkdir(join(home, "Desktop"), { recursive: true });
    await writeFile(desktop, "[Desktop Entry]\nType=Application\nExec=old-launcher\n", { mode: 0o755 });
    const block = installer.slice(start, end).replaceAll("/usr/local/share/applications", applications);
    // Redirect account lookup to a disposable home; all entry creation and
    // ownership commands are the real installer block. No desktop is touched.
    const setup = `export SUDO_USER=daemon\ngetent() { printf 'daemon:x:1:1::%s:/usr/sbin/nologin\\n' '${home}'; }\n`;
    for (let run = 0; run < 2; run++) {
      execFileSync("/usr/bin/bash", ["-euc", setup + block]);
      const application = join(applications, "lancerlogin-kiosk.desktop");
      assert.match(await readFile(desktop, "utf8"), /^Type=Link$/m);
      assert.ok((await readFile(desktop, "utf8")).includes(`URL=${application}\n`));
      assert.doesNotMatch(await readFile(desktop, "utf8"), /^Exec=/m);
      assert.match(await readFile(application, "utf8"), /^Exec=\/usr\/local\/bin\/lancerlogin-open-kiosk$/m);
      assert.match(await readFile(application, "utf8"), /^Terminal=false$/m);
      assert.equal(execFileSync("stat", ["-c", "%U:%G:%a", application], { encoding: "utf8" }).trim(), "root:root:644");
      assert.equal(execFileSync("stat", ["-c", "%U:%G:%a", desktop], { encoding: "utf8" }).trim(), "daemon:daemon:644");
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("Linux installer migrates an in-place install, switches releases atomically, rolls back a failed release and keeps state bytes", { skip: process.platform !== "linux" || process.getuid?.() !== 0 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-release-switch-"));
  try {
    await chmod(scratch, 0o755); // The unprivileged import check runs as nobody.
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version: "9.9.9" });
    const archive = join(artifacts, "lancerlogin-kiosk-9.9.9-linux-arm64.tar.gz");
    // A release whose service never becomes healthy and whose helper differs from the healthy one.
    const brokenTree = join(scratch, "broken-tree"); await mkdir(brokenTree);
    execFileSync(tar.path, ["-xzf", archive, "-C", brokenTree]);
    await writeFile(join(brokenTree, "src/service.mjs"), `${await readFile(join(brokenTree, "src/service.mjs"), "utf8")}\n// BROKEN test release\n`);
    await writeFile(join(brokenTree, "scripts/lancerlogin-install-release.sh"), `${await readFile(join(brokenTree, "scripts/lancerlogin-install-release.sh"), "utf8")}# broken helper\n`);
    const brokenArchive = join(scratch, "broken.tar.gz");
    await writeKioskArchive(brokenTree, brokenArchive);
    const installer = await readFile(join(artifacts, "install-lancerlogin.sh"), "utf8");
    const mainStart = installer.indexOf("\ncheck_runtime_layout\n");
    const mainEnd = installer.indexOf('prune_releases "$new_release" "$previous_release"\n', mainStart);
    assert.ok(mainStart > 0 && mainEnd > mainStart);
    const main = installer.slice(mainStart, mainEnd + 'prune_releases "$new_release" "$previous_release"\n'.length);

    const root = join(scratch, "root");
    const runtime = join(root, "opt/lancerlogin"); const state = join(root, "var/lib/lancerlogin");
    const units = join(root, "etc/systemd/system"); const helper = join(root, "usr/local/sbin/lancerlogin-install-release");
    const launcher = join(root, "usr/local/bin/lancerlogin-open-kiosk");
    for (const directory of [runtime, units + "/lancerlogin-kiosk.service.d", join(root, "usr/local/sbin"), join(root, "usr/local/bin")]) await mkdir(directory, { recursive: true });
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeNodeWrapper(root);
    // Pre-versioned layout: code directly in /opt/lancerlogin, legacy unit, helper and launcher paths.
    execFileSync(tar.path, ["-xzf", archive, "-C", runtime]);
    await writeFile(join(units, "lancerlogin-kiosk.service.d/10-version.conf"), "[Service]\nEnvironment=LANCERLOGIN_VERSION=9.9.8\n");
    const legacyUnit = "[Service]\nExecStart=/usr/bin/node /opt/lancerlogin/src/service.mjs\n";
    await writeFile(join(units, "lancerlogin-kiosk.service"), legacyUnit);
    await writeFile(helper, "#!/bin/bash\n# legacy helper\n", { mode: 0o755 });
    await writeFile(launcher, "#!/bin/bash\n# legacy launcher\n", { mode: 0o755 });
    await writeFile(join(root, "active"), "");
    const retained = { "pairing.json": '{"kioskToken":"synthetic-retained-token"}', "slot-mappings.json": '{"107":"SYN-001"}', "attendance-queue.json": '[{"eventId":"synthetic-before-upgrade","memberId":"SYN-001","occurredAt":"2026-10-01T10:00:00Z"}]', "network-pin.json": '{"hash":"synthetic-retained-hash"}' };
    for (const [name, bytes] of Object.entries(retained)) await writeFile(join(state, name), bytes, { mode: 0o600 });

    const run = (version, source) => {
      const temporary = mkdtempSync(join(scratch, "run-"));
      const name = `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`;
      copyFileSync(source, join(temporary, name));
      const script = `${installerHarness(installer, root)}
VERSION=${JSON.stringify(version)}
archive=${JSON.stringify(name)}
temporary=${JSON.stringify(temporary)}
SENSOR_PATH_EXPLICIT=false
phase=prepare
kiosk_was_active=false
previous_release=""
new_release=""
trap on_exit EXIT
${main}`;
      return execFileSync("/usr/bin/bash", ["-c", script], { encoding: "utf8", stdio: "pipe" });
    };
    const link = (name) => execFileSync("readlink", [join(runtime, name)], { encoding: "utf8" }).trim();
    const releases = async () => (await readdir(join(runtime, "releases"))).sort();
    const versionConf = () => readFile(join(units, "lancerlogin-kiosk.service.d/10-version.conf"), "utf8");

    // 1. Migration from the in-place layout plus a healthy upgrade.
    run("9.9.9", archive);
    assert.match(link("current"), /^releases\/9\.9\.9_\d{8}T\d{6}Z$/);
    assert.equal(link("previous"), "releases/legacy_9.9.8");
    assert.equal(link("src"), "current/src");
    assert.deepEqual((await readdir(runtime)).sort(), ["current", "previous", "releases", "src"]);
    assert.deepEqual(await releases(), [link("current").slice("releases/".length), "legacy_9.9.8"].sort());
    assert.ok((await readdir(join(runtime, "releases/legacy_9.9.8/src"))).includes("service.mjs"));
    assert.match(await versionConf(), /^Environment=LANCERLOGIN_VERSION=9\.9\.9$/m);
    assert.match(await readFile(join(units, "lancerlogin-kiosk.service"), "utf8"), /^ExecStart=\/usr\/bin\/node \/opt\/lancerlogin\/current\/src\/service\.mjs$/m);
    assert.equal(await readFile(helper, "utf8"), await readFile(join(runtime, "current/scripts/lancerlogin-install-release.sh"), "utf8"));
    assert.equal(await readFile(launcher, "utf8"), await readFile(join(runtime, "current/scripts/lancerlogin-open-kiosk.sh"), "utf8"));
    assert.match(await readFile(join(root, "etc/polkit-1/rules.d/49-lancerlogin-update.rules"), "utf8"), /action\.lookup\("verb"\) === "start"/);
    // The drop-in cleaner runs only as the main module, so it is invoked by its resolved release path.
    assert.match(await readFile(join(root, "clean.log"), "utf8"), /\/opt\/lancerlogin\/releases\/9\.9\.9_[^/]+\/src\/clean-version-overrides\.mjs$/m);
    const log = await readFile(join(root, "systemctl.log"), "utf8");
    assert.ok(log.indexOf("stop lancerlogin-kiosk.service") < log.indexOf("restart lancerlogin-kiosk.service"));
    const healthy = link("current");
    const healthyHelper = await readFile(helper, "utf8");

    // 2. A release that never becomes healthy is rolled back to the previous release and system files.
    assert.throws(() => run("9.9.10", brokenArchive), error => {
      assert.match(String(error.stderr), /did not become healthy\. Restoring 9\.9\.9_/);
      assert.match(String(error.stderr), /previous release is running again/);
      return true;
    });
    assert.equal(link("current"), healthy);
    assert.equal(link("previous"), "releases/legacy_9.9.8");
    assert.match(await versionConf(), /^Environment=LANCERLOGIN_VERSION=9\.9\.9$/m);
    assert.equal(await readFile(helper, "utf8"), healthyHelper);
    assert.deepEqual(await releases(), [healthy.slice("releases/".length), "legacy_9.9.8"].sort());
    await readFile(join(root, "active"));

    // 3. The next healthy upgrade keeps exactly the active and previous releases.
    run("9.9.11", archive);
    assert.match(link("current"), /^releases\/9\.9\.11_/);
    assert.equal(link("previous"), healthy);
    assert.deepEqual(await releases(), [link("current").slice("releases/".length), healthy.slice("releases/".length)].sort());

    // 4. Unexpected runtime content stops before the running service is touched.
    await writeFile(join(runtime, "stray"), "unexpected");
    await writeFile(join(root, "systemctl.log"), "");
    assert.throws(() => run("9.9.12", archive), error => { assert.match(String(error.stderr), /Unexpected .*stray/); return true; });
    assert.doesNotMatch(await readFile(join(root, "systemctl.log"), "utf8"), /stop/);
    await rm(join(runtime, "stray"));

    // 5. A release that fails the import check on this kiosk never stops the running service.
    const unloadable = join(scratch, "unloadable-tree"); await mkdir(unloadable);
    execFileSync(tar.path, ["-xzf", archive, "-C", unloadable]);
    await writeFile(join(unloadable, "src/service.mjs"), `import "./missing-module.mjs";\n${await readFile(join(unloadable, "src/service.mjs"), "utf8")}`);
    await writeKioskArchive(unloadable, join(scratch, "unloadable.tar.gz"));
    assert.throws(() => run("9.9.13", join(scratch, "unloadable.tar.gz")), error => { assert.match(String(error.stderr), /failed its import check/); return true; });
    assert.doesNotMatch(await readFile(join(root, "systemctl.log"), "utf8"), /stop/);
    assert.match(link("current"), /^releases\/9\.9\.11_/);
    assert.equal((await releases()).length, 2);

    for (const [name, bytes] of Object.entries(retained)) {
      assert.equal(await readFile(join(state, name), "utf8"), bytes);
      assert.equal(execFileSync("stat", ["-c", "%a", join(state, name)], { encoding: "utf8" }).trim(), "600");
    }
    assert.equal(execFileSync("stat", ["-c", "%a", state], { encoding: "utf8" }).trim(), "700");
    assert.equal(execFileSync("stat", ["-c", "%a", runtime], { encoding: "utf8" }).trim(), "755");
    assert.match(installer, /Enter a dashboard one-time pairing key only if the kiosk shows the pairing screen/);

    // 6. A fresh install has no rollback target.
    const fresh = join(scratch, "fresh"); await chmod(scratch, 0o755);
    for (const directory of ["opt/lancerlogin", "etc/systemd/system", "usr/local/sbin"]) await mkdir(join(fresh, directory), { recursive: true });
    await writeNodeWrapper(fresh);
    const temporary = await mkdtemp(join(scratch, "run-"));
    await writeFile(join(temporary, "lancerlogin-kiosk-9.9.9-linux-arm64.tar.gz"), await readFile(archive));
    execFileSync("/usr/bin/bash", ["-c", `${installerHarness(installer, fresh)}
VERSION=9.9.9
archive=lancerlogin-kiosk-9.9.9-linux-arm64.tar.gz
temporary=${JSON.stringify(temporary)}
SENSOR_PATH_EXPLICIT=false
phase=prepare
kiosk_was_active=false
previous_release=""
new_release=""
trap on_exit EXIT
${main}`], { stdio: "pipe" });
    assert.deepEqual((await readdir(join(fresh, "opt/lancerlogin"))).sort(), ["current", "releases", "src"]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("both shipped archives load and serve their isolated runtime; missing imports fail closed", { skip: toolSkip(tar) }, async () => {
  requireTool(tar);
  const scratch = await mkdtemp(join(tmpdir(), "lancerlogin-artifact-test-"));
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  try {
    const artifacts = await packageKioskArtifacts({ output: join(scratch, "artifacts"), version });
    for (const arch of kioskArchitectures) {
      const extracted = join(scratch, arch);
      await mkdir(extracted);
      execFileSync(tar.path, ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`), "-C", extracted]);
      checkKioskArchiveModes(await readFile(join(artifacts, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`)));
      const expected = [...(await readdir("apps/kiosk/src")).filter(name => name.endsWith(".mjs")), "release-policy.mjs"].sort();
      assert.deepEqual((await readdir(join(extracted, "src"))).sort(), expected);
      assert.equal(await readFile(join(extracted, "src/release-policy.mjs"), "utf8"), await readFile("packages/shared/src/release-policy.mjs", "utf8"));
      for (const missing of ["update-command.mjs", "kiosk-presentation.mjs", "release-policy.mjs", "resolve-kiosk-release.mjs"]) {
        // Re-extract between failures so each missing direct/transitive import is tested alone.
        execFileSync(tar.path, ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-${arch}.tar.gz`), "-C", extracted]);
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
    execFileSync(tar.path, ["-xzf", join(artifacts, name), "-C", broken]);
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
  const gate = workflow.indexOf('sudo "$(command -v node)" release-source/scripts/package-kiosk.mjs release/artifacts --require-unprivileged');
  const sourceGate = workflow.indexOf('release-publication.mjs resolve "$RELEASE_TAG"');
  const bundleGate = workflow.indexOf('release-publication.mjs bundle "$RELEASE_TAG"');
  const uploadGate = workflow.indexOf("actions/upload-artifact@v4");
  assert.ok(sourceGate >= 0 && gate > sourceGate);
  assert.ok(bundleGate > gate && uploadGate > bundleGate);
  assert.doesNotMatch(workflow, /contents: write|gh release create|gh release edit/);
  assert.doesNotMatch(workflow, /continue-on-error|if: always\(\)|cp apps\/kiosk\/src/);
  assert.match(workflow, /actions\/setup-node@/);
  const publisher = await readFile("scripts/release-publication.mjs", "utf8");
  assert.match(publisher, /v\$\{version\}.*!== tag/);
  assert.match(publisher, /linux_verified_artifacts_required/);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(manifest.scripts["test:kiosk"], /tests\/kiosk-artifacts\.test\.mjs/);
  assert.match(manifest.scripts.test, /tests\/\*\*\/\*\.test\.mjs/);
});


test("valid-checksum archives with inaccessible or writable code fail permission validation on every host", { skip: toolSkip(tar) }, async () => {
  requireTool(tar);
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
    execFileSync(tar.path, ["-xzf", join(artifacts, `lancerlogin-kiosk-${version}-linux-arm64.tar.gz`), "-C", extracted]);
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
    const repair = installer.match(/^  chmod 0755 "\$staging"\n  normalize_tree_permissions "\$staging"$/m)?.[0];
    const normalize = installer.match(/^normalize_tree_permissions\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(repair && normalize);
    const repairBlock = `${normalize}\nstaging=${JSON.stringify(extracted)}\n${repair}`;
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

test("installer archives obsolete version assignments and preserves unrelated overrides", async () => {
  const { cleanDevelopmentVersionOverrides, withoutDevelopmentVersionOverrides } = await import("../apps/kiosk/src/clean-version-overrides.mjs");
  const root = await mkdtemp(join(tmpdir(), "kiosk-overrides-"));
  try {
    const overrides = join(root, "overrides"), backups = join(root, "backups"); await mkdir(overrides);
    const official = "[Service]\nEnvironment=LANCERLOGIN_VERSION=2.0.0-beta.4\n";
    const old = '[Service]\nEnvironment="LANCERLOGIN_VERSION=2.0.0-dev.gesture.abcdef0"\nEnvironment=READER_PORT=/dev/ttyUSB0\n';
    await writeFile(join(overrides, "10-version.conf"), official);
    await writeFile(join(overrides, "99-gesture.conf"), old);
    const result = await cleanDevelopmentVersionOverrides(overrides, backups);
    assert.equal(result.changed, 1);
    assert.equal(await readFile(join(result.backup, "99-gesture.conf"), "utf8"), old);
    assert.equal(await readFile(join(overrides, "99-gesture.conf"), "utf8"), "[Service]\nEnvironment=READER_PORT=/dev/ttyUSB0\n");
    assert.equal(await readFile(join(overrides, "10-version.conf"), "utf8"), official);
    assert.deepEqual(await cleanDevelopmentVersionOverrides(overrides, backups), { changed: 0 });
    assert.equal(withoutDevelopmentVersionOverrides(official), official);
    assert.throws(() => withoutDevelopmentVersionOverrides('Environment="LANCERLOGIN_VERSION=2.0.0-dev.foo.abcdef0" "OTHER=yes"\n'), /compound/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
