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
  assert.match(checklist, /fresh endpoint active/);
  assert.match(checklist, /physical acceptance pending/);
  const audit = await readFile("docs/COMPLETION-AUDIT.md", "utf8");
  assert.match(audit, /Community release completion audit/);
  assert.match(audit, /fresh collector endpoint deployed and active/);
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

test("guided setup schema keeps simulator credentials isolated from hardware kiosks", async () => {
  const migration = await readFile("apps/api/migrations/0003_guided_setup_simulator.sql", "utf8");
  assert.match(migration, /is_test INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /purpose IN \('hardware', 'simulator'\)/);
  assert.match(migration, /simulated_kiosk_sessions/);
  assert.doesNotMatch(migration, /token_hash|fingerprint|template/i);
});

test("roster account schema links optional credentials without biometric or password fields", async () => {
  const migration = await readFile("apps/api/migrations/0004_roster_accounts.sql", "utf8");
  assert.match(migration, /member_id TEXT REFERENCES members\(id\) ON DELETE SET NULL/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS idx_one_user_per_member/);
  assert.doesNotMatch(migration, /fingerprint|template|password_hash/i);
});

test("attendance lifecycle migration adds complete sessions and durable Discord delivery", async () => {
  const migration = await readFile("apps/api/migrations/0005_attendance_lifecycle.sql", "utf8");
  assert.match(migration, /late_scan_minutes INTEGER NOT NULL DEFAULT 30/);
  assert.match(migration, /action IN \('check_in', 'check_out'\)/);
  assert.match(migration, /UPDATE meetings[\s\S]*ends_at = datetime\(starts_at, '\+1 hour'\)[\s\S]*ends_at IS NULL/);
  assert.match(migration, /discord_attendance_notifications/);
  assert.match(migration, /discord_attendance_recipients/);
  assert.doesNotMatch(migration, /fingerprint_template|raw_fingerprint|biometric_template/i);
});

test("dashboard restore accepts and normalizes earlier backup schemas", async () => {
  const source = await readFile("apps/api/src/index.ts", "utf8");
  assert.match(source, /\[1, 2, 3, 4, 5\]\.includes\(Number\(value\.schemaVersion\)\)/);
  assert.match(source, /legacy-restore-checkout:/);
  assert.match(source, /late_scan_minutes: 30, logo_backdrop: "auto"/);
  assert.match(source, /recurrence_frequency: null/);
  assert.match(source, /deleted_at: null/);
});

test("recurring meeting migration stores series metadata without biometric data", async () => {
  const migration = await readFile("apps/api/migrations/0006_recurring_meetings.sql", "utf8");
  assert.match(migration, /recurrence_frequency/);
  assert.match(migration, /idx_meetings_series/);
  assert.doesNotMatch(migration, /fingerprint|template|biometric/i);
});

test("integration verification migration stores only proof state and hashed challenges", async () => {
  const migration = await readFile("apps/api/migrations/0007_integration_verification.sql", "utf8");
  assert.match(migration, /verified_at TEXT/);
  assert.match(migration, /challenge_hash TEXT NOT NULL/);
  assert.match(migration, /idx_integration_verification_expiry/);
  assert.doesNotMatch(migration, /raw_ip|fingerprint|template|biometric/i);
});

test("entire-installation restore inserts roster members before linked dashboard users", async () => {
  const source = await readFile("apps/api/src/index.ts", "utf8");
  const order = source.match(/const installationTables: BackupTable\[\] = \[([\s\S]*?)\];/)?.[1] ?? "";
  assert.ok(order.indexOf('"members"') >= 0);
  assert.ok(order.indexOf('"users"') > order.indexOf('"members"'));
  assert.ok(order.indexOf('"meetings"') > order.indexOf('"users"'));
  assert.ok(order.indexOf('"attendance_events"') > order.indexOf('"meetings"'));
});

test("provisioning workflow is adopter-gated and account-neutral", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /Require a private deployment repository/);
  assert.match(workflow, /release:\s+[\s\S]*type: choice[\s\S]*- latest stable[\s\S]*- original template release/);
  assert.doesNotMatch(workflow, /release_tag:\s/);
  assert.match(workflow, /gh api repos\/isriah\/LancerLogin\/releases\/latest --jq \.tag_name/);
  assert.match(workflow, /ref: \$\{\{ steps\.release\.outputs\.tag \}\}/);
  assert.match(workflow, /REPOSITORY_PRIVATE/);
  assert.match(workflow, /repository: isriah\/LancerLogin/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /secrets\.LANCERLOGIN_SETUP_CODE/);
  assert.match(workflow, /cfat_/);
  assert.match(workflow, /INPUT_OPERATION.*create\|resume\|upgrade/);
  assert.doesNotMatch(workflow, /INPUT_CONFIRMATION|inputs\.confirmation/);
  assert.match(workflow, /RESUME|resume/);
  assert.match(workflow, /UPGRADE|upgrade/);
  assert.match(workflow, /accounts\/\$CLOUDFLARE_ACCOUNT_ID\/pages\/projects/);
  assert.doesNotMatch(workflow, /pages project list --json/);
  assert.match(workflow, /Generate installation secrets\s+if: steps\.resources\.outputs\.worker_secrets == 'missing'/);
  assert.match(workflow, /BOOTSTRAP_CODE_HASH/);
  assert.match(workflow, /wrangler secret list --format json/);
  assert.doesNotMatch(workflow, /wrangler secret list --json/);
  assert.match(workflow, /Deploy existing Worker API without rotating secrets/);
  assert.match(workflow, /workingDirectory: lancerlogin-source/);
  assert.match(workflow, /Upload generated Worker secrets/);
  assert.match(workflow, /wrangler secret bulk --config \.provision\/wrangler\.json/);
  assert.doesNotMatch(workflow, /preCommands:/);
  assert.match(workflow, /if: steps\.resources\.outputs\.worker_secrets == 'exists'/);
  assert.match(workflow, /VITE_API_BASE_URL: \/api/);
  assert.match(workflow, /prepare-pages-proxy\.mjs/);
  assert.equal((workflow.match(/secrets:\s*\|/g) ?? []).length, 0);
  assert.match(workflow, /accounts\/\$CLOUDFLARE_ACCOUNT_ID\/tokens\/verify/);
  assert.doesNotMatch(workflow, /user\/tokens\/verify/);
  assert.equal((workflow.match(/accountId: \$\{\{ env\.CLOUDFLARE_ACCOUNT_ID \}\}/g) ?? []).length, 3);
  assert.doesNotMatch(workflow, /accountId:\s*[a-f0-9]{32}|account_id\s*[:=]\s*[a-f0-9]{32}/i);
  assert.doesNotMatch(workflow, /run:[\s\S]{0,300}\$\{\{ inputs\.(?:operation|confirmation|installation_slug) \}\}/);
});

test("CI runs the complete release gate and tags require that exact verified commit", async () => {
  const packageDocument = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageDocument.scripts["verify:migrations"], "node scripts/verify-d1-migrations.mjs");
  assert.match(packageDocument.scripts["verify:all"], /verify:migrations.*typecheck.*test.*build/);
  assert.match(packageDocument.scripts["verify:release"], /verify:all.*npm audit --audit-level=high/);
  const verifier = await readFile("scripts/verify-d1-migrations.mjs", "utf8");
  assert.match(verifier, /d1", "migrations", "apply"/);
  assert.match(verifier, /"--local"/);
  assert.match(verifier, /SELECT name FROM d1_migrations/);
  assert.match(verifier, /fingerprint_template\|raw_fingerprint\|biometric_template/);
  assert.doesNotMatch(verifier, /--remote|CLOUDFLARE_API_TOKEN/);
  const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ciWorkflow, /npm run verify:release/);
  assert.match(ciWorkflow, /rhysd\/actionlint:1\.7\.12/);
  assert.match(ciWorkflow, /npm run test:browser/);
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(releaseWorkflow, /actions: read/);
  assert.match(releaseWorkflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$commit&status=success/);
  assert.match(releaseWorkflow, /\.event == "push"/);
  assert.match(releaseWorkflow, /\.head_branch == "main"/);
  assert.doesNotMatch(releaseWorkflow, /npm (?:ci|test|audit)|npm run (?:verify:migrations|typecheck|build)/);
  assert.match(releaseWorkflow, /docs\/releases\/\$GITHUB_REF_NAME\.md/);
  assert.match(releaseWorkflow, /--notes-file/);
  assert.doesNotMatch(releaseWorkflow, /--generate-notes/);
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
  assert.match(workflow, /Deploy existing collector with retained secret values/);
  assert.match(workflow, /workingDirectory: \.collector/);
  assert.match(workflow, /preCommands: npx wrangler deploy/);
  assert.match(workflow, /Exercise and remove a mock report/);
  assert.match(workflow, /Adopter releases activate the reviewed public endpoint separately/);
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
