import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { can } from "../packages/shared/src/policy.mjs";
import { createApiHarness } from "../apps/api/src/test-harness.mjs";

test("foundation documents state standalone constraints", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /standalone/i);
  assert.match(readme, /sensor/i);
  const checklist = await readFile("docs/RELEASE-CHECKLIST.md", "utf8");
  assert.match(checklist, /Community release requirement checklist/);
  assert.match(checklist, /fresh endpoint deployment pending/);
  assert.match(checklist, /physical acceptance pending/);
  const audit = await readFile("docs/COMPLETION-AUDIT.md", "utf8");
  assert.match(audit, /Community release completion audit/);
  assert.match(audit, /fresh collector endpoint deployment pending/);
  assert.match(audit, /physical acceptance pending/);
  const license = await readFile("LICENSE", "utf8");
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /You may add Your own copyright statement to Your modifications/);
  assert.match(license, /nothing herein shall supersede or modify/);
  assert.match(license, /APPENDIX: How to apply the Apache License/);
});

test("operator permissions match the approved role boundary", () => {
  assert.equal(can("operator", "manage-meetings"), true);
  assert.equal(can("operator", "manage-attendance"), true);
  assert.equal(can("operator", "manage-branding"), false);
  assert.equal(can("operator", "manage-integrations"), false);
  assert.equal(can("operator", "destructive-configuration"), false);
});

test("API harness rejects protected operations for operators", () => {
  const api = createApiHarness();
  const operator = { userId: "u-1", role: "operator" };
  assert.deepEqual(api.request(operator, "createMeeting"), { ok: true });
  assert.throws(() => api.request(operator, "configureIntegration"), { message: "Forbidden", status: 403 });
  assert.throws(() => api.request(operator, "deleteInstallation"), { message: "Forbidden", status: 403 });
});

test("initial schema preserves the biometric and secret boundary", async () => {
  const schema = await readFile("apps/api/migrations/0001_initial.sql", "utf8");
  assert.match(schema, /encrypted_integrations/);
  assert.doesNotMatch(schema, /fingerprint_template/i);
  assert.doesNotMatch(schema, /raw_fingerprint/i);
  assert.match(schema, /logo_data TEXT/);
  assert.match(schema, /failed_login_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /locked_until TEXT/);
  assert.doesNotMatch(schema, /logo_url/i);
  assert.match(schema, /UNIQUE INDEX IF NOT EXISTS idx_one_active_kiosk ON kiosks\(installation_id\) WHERE active = 1/);
});

test("follow-up schema adds explicit themed branding and retained kiosk health", async () => {
  const migration = await readFile("apps/api/migrations/0002_branding_and_kiosk_health.sql", "utf8");
  assert.match(migration, /'themed'/);
  assert.match(migration, /reader_online INTEGER/);
  assert.match(migration, /release_version TEXT/);
  assert.doesNotMatch(migration, /fingerprint|template/i);
});

test("provisioning workflow is adopter-gated and account-neutral", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /cfat_/);
  assert.match(workflow, /expected=.*inputs\.operation/);
  assert.match(workflow, /inputs\.confirmation.*expected.*inputs\.installation_slug/);
  assert.match(workflow, /RESUME|resume/);
  assert.match(workflow, /Generate installation session key\s+if: steps\.resources\.outputs\.worker == 'missing'/);
  assert.match(workflow, /Deploy existing Worker API without rotating secrets/);
  assert.match(workflow, /if: steps\.resources\.outputs\.worker == 'exists'/);
  assert.match(workflow, /VITE_API_BASE_URL: \/api/);
  assert.match(workflow, /prepare-pages-proxy\.mjs/);
  assert.equal((workflow.match(/secrets:\s*\|/g) ?? []).length, 1);
  assert.match(workflow, /accounts\/\$CLOUDFLARE_ACCOUNT_ID\/tokens\/verify/);
  assert.doesNotMatch(workflow, /user\/tokens\/verify/);
  assert.equal((workflow.match(/accountId: \$\{\{ env\.CLOUDFLARE_ACCOUNT_ID \}\}/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /accountId:\s*[a-f0-9]{32}|account_id\s*[:=]\s*[a-f0-9]{32}/i);
});

test("CI and tagged releases apply the complete D1 migration chain locally", async () => {
  const packageDocument = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageDocument.scripts["verify:migrations"], "node scripts/verify-d1-migrations.mjs");
  const verifier = await readFile("scripts/verify-d1-migrations.mjs", "utf8");
  assert.match(verifier, /d1", "migrations", "apply"/);
  assert.match(verifier, /"--local"/);
  assert.match(verifier, /SELECT name FROM d1_migrations/);
  assert.match(verifier, /fingerprint_template\|raw_fingerprint\|biometric_template/);
  assert.doesNotMatch(verifier, /--remote|CLOUDFLARE_API_TOKEN/);
  for (const workflowPath of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    assert.match(await readFile(workflowPath, "utf8"), /npm run verify:migrations/);
  }
});

test("Cloudflare setup is adopter-guided and does not require a target account", async () => {
  const guide = await readFile("docs/CLOUDFLARE-LINKING.md", "utf8");
  assert.match(guide, /adopter's own Cloudflare account/i);
  assert.match(guide, /CLOUDFLARE_API_TOKEN/);
  assert.match(guide, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(guide, /Account Settings Read/);
  assert.doesNotMatch(guide, /account_id\s*=|database_id\s*=/i);
});

test("telemetry deployment is dedicated, collision-safe, and does not activate adopter reporting", async () => {
  const workflow = await readFile(".github/workflows/deploy-telemetry-collector.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment: telemetry-production/);
  assert.match(workflow, /LANCERLOGIN_TELEMETRY_CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /LANCERLOGIN_TELEMETRY_CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /cfat_/);
  assert.match(workflow, /LANCERLOGIN_TELEMETRY_INSTALL_PEPPER/);
  assert.match(workflow, /LANCERLOGIN_TELEMETRY_ADMIN_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /CREATE LANCERLOGIN TELEMETRY/);
  assert.match(workflow, /test "\$database" = "missing"/);
  assert.match(workflow, /test "\$worker" = "missing"/);
  assert.match(workflow, /Deploy existing collector without rotating secrets/);
  assert.match(workflow, /Exercise and remove a mock report/);
  assert.match(workflow, /No adopter release endpoint is changed by this workflow/);
  assert.doesNotMatch(workflow, /TELEMETRY_ENDPOINT=/);
});

test("approved telemetry governance is public and operational", async () => {
  const policy = await readFile("docs/TELEMETRY-GOVERNANCE.md", "utf8");
  assert.match(policy, /RoboLancers operates/);
  assert.match(policy, /robolancers@gmail\.com/);
  assert.match(policy, /30 days/);
  assert.match(policy, /designated RoboLancers maintainers/);
  assert.match(policy, /deletion-request reference/);
  assert.match(policy, /plain-language notice/);
});
