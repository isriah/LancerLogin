import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { missingReleaseFiles, provisionReleaseRequirements } from "../scripts/check-provision-release-compat.mjs";

// File lists from the immutable official v1.0.5 and v1.2.6 tags, limited to the package manifests and scripts directory.
const common = ["package-lock.json", "package.json", "scripts/audit-dependencies.mjs", "scripts/cloudflare-resource-state.mjs", "scripts/d1-maintenance.mjs", "scripts/database-identity.mjs", "scripts/package-kiosk.mjs", "scripts/prepare-cloudflare-provision.mjs", "scripts/prepare-pages-proxy.mjs", "scripts/provision-plan.mjs", "scripts/recover-web-update.mjs", "scripts/refresh-web-update-credential.mjs", "scripts/rehearse-web-upgrade.mjs", "scripts/reset-local-password.mjs", "scripts/run-browser-tests.mjs", "scripts/run-web-upgrade.mjs", "scripts/select-cloudflare-account.mjs", "scripts/verify-d1-migrations.mjs", "scripts/verify-template-config.mjs", "scripts/web-upgrade-policy.json"];
const stableReleases = {
  "v1.0.5": common,
  "v1.2.6": [...common, "scripts/d1-usage-report.mjs", "scripts/release-channel.mjs", "scripts/run-web-tests.mjs"]
};

test("installation workflow runs only files present in every selectable stable release", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  const requirements = provisionReleaseRequirements(workflow);
  assert.equal(requirements.templateRelease, "v1.0.5");
  assert.ok(requirements.required.includes("scripts/prepare-cloudflare-provision.mjs"));
  assert.ok(requirements.required.includes("scripts/refresh-web-update-credential.mjs"));
  assert.ok(requirements.required.includes("package-lock.json"));
  assert.deepEqual(requirements.guarded, ["scripts/compose-modules.mjs", "scripts/ensure-fingerprint-vault-key.mjs"]);
  for (const [tag, files] of Object.entries(stableReleases)) assert.deepEqual(missingReleaseFiles(requirements, files), [], tag);
});

test("an unguarded script missing from an older release is reported", async () => {
  const workflow = (await readFile(".github/workflows/provision-template.yml", "utf8")).replace(/if \[ -f scripts\/ensure-fingerprint-vault-key\.mjs \]; then/, "if true; then");
  const requirements = provisionReleaseRequirements(workflow);
  for (const files of Object.values(stableReleases)) assert.deepEqual(missingReleaseFiles(requirements, files), ["scripts/ensure-fingerprint-vault-key.mjs"]);
  assert.deepEqual(missingReleaseFiles(requirements, [...stableReleases["v1.2.6"], "scripts/ensure-fingerprint-vault-key.mjs"]), []);
});

test("an unguarded plugin composition step missing from an older release is reported", async () => {
  const workflow = (await readFile(".github/workflows/provision-template.yml", "utf8")).replace(/if \[ -f scripts\/compose-modules\.mjs \]; then/, "if true; then");
  const requirements = provisionReleaseRequirements(workflow);
  for (const files of Object.values(stableReleases)) assert.deepEqual(missingReleaseFiles(requirements, files), ["scripts/compose-modules.mjs"]);
  assert.deepEqual(missingReleaseFiles(requirements, [...stableReleases["v1.2.6"], "scripts/compose-modules.mjs"]), []);
});

test("steps that run from the controller checkout are not release requirements", () => {
  const workflow = [
    "jobs:",
    "  provision:",
    "    defaults:",
    "      run:",
    "        working-directory: lancerlogin-source",
    "    steps:",
    "      - name: Controller step",
    "        working-directory: .",
    "        run: node scripts/controller-only.mjs",
    "      - name: Release step",
    "        run: node scripts/release-only.mjs"
  ].join("\n");
  assert.deepEqual(provisionReleaseRequirements(workflow).required, ["package.json", "scripts/release-only.mjs"]);
});
