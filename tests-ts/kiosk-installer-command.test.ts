import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

(globalThis as { __LANCERLOGIN_VERSION__?: string }).__LANCERLOGIN_VERSION__ = "2.0.0-beta.16";
const { dashboardReleaseVersion, kioskInstallCommands, kioskInstallerUrl, kioskInstallerUrlFor } = await import("../apps/dashboard/src/hardware-pairing-key.ts");

test("the kiosk installer is pinned to the release this dashboard runs", () => {
  assert.equal(dashboardReleaseVersion, "2.0.0-beta.16");
  assert.equal(kioskInstallerUrl, "https://github.com/isriah/LancerLogin/releases/download/v2.0.0-beta.16/install-lancerlogin.sh");
  assert.equal(kioskInstallerUrlFor("v1.2.6"), "https://github.com/isriah/LancerLogin/releases/download/v1.2.6/install-lancerlogin.sh");
  // A development build has no published installer of its own.
  assert.equal(kioskInstallerUrlFor("local-build"), "https://github.com/isriah/LancerLogin/releases/latest/download/install-lancerlogin.sh");
});

test("install commands preview first and add --no-fingerprint-reader only without an R503", () => {
  assert.deepEqual(kioskInstallCommands(true).split("\n"), [
    "curl -fLO https://github.com/isriah/LancerLogin/releases/download/v2.0.0-beta.16/install-lancerlogin.sh",
    "sudo bash install-lancerlogin.sh --dry-run",
    "sudo bash install-lancerlogin.sh --install",
  ]);
  assert.deepEqual(kioskInstallCommands(false).split("\n").slice(1), [
    "sudo bash install-lancerlogin.sh --dry-run --no-fingerprint-reader",
    "sudo bash install-lancerlogin.sh --install --no-fingerprint-reader",
  ]);
});

test("the installer accepts the documented modes and serves the pairing page on port 8788", async () => {
  const installer = await readFile("apps/kiosk/scripts/install-lancerlogin.sh", "utf8");
  assert.match(installer, /\[\[ "\$MODE" == "--dry-run" \]\]/);
  assert.match(installer, /\[\[ "\$MODE" == "--install" \]\]/);
  assert.match(installer, /"\$SENSOR_OPTION" == "--no-fingerprint-reader"/);
  assert.match(installer, /Node\.js 18 or newer must be installed at \/usr\/bin\/node/);
  assert.match(installer, /nmcli/);
  assert.match(installer, /SENSOR_PATH="\$\{LANCERLOGIN_SENSOR_PATH:-\/dev\/serial0\}"/);
  assert.match(installer, /http:\/\/\$\{host_name\}\.local:8788\//);
});
