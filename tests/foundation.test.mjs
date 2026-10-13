import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { can } from "../packages/shared/src/policy.mjs";
import { createApiHarness } from "../apps/api/src/test-harness.mjs";

test("foundation documents state standalone constraints", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /standalone/i);
  assert.match(readme, /sensor/i);
  const security = await readFile("docs/SECURITY.md", "utf8");
  assert.match(security, /signed interactions/i);
  assert.match(security, /HMAC-SHA256/);
  assert.match(security, /no remote destructive wipe/i);
  const privacy = await readFile("docs/PRIVACY.md", "utf8");
  assert.match(privacy, /reporting/i);
  assert.match(privacy, /raw badge and QR values, local digests, and the transform secret are not sent/i);
  assert.match(privacy, /Sync is off by default/);
  assert.match(privacy, /approve peer device identities/);
  assert.match(privacy, /without receiving the recipient's private decryption key/);
  assert.match(privacy, /Existing unidentified sensor slots and imported legacy mappings are not automatically exported/);
  assert.match(privacy, /None of these actions erase templates or mappings already copied/);
  const kiosk = await readFile("docs/KIOSK.md", "utf8");
  assert.match(kiosk, /Fingerprint remains the default/);
  assert.match(kiosk, /keyboard-wedge/);
  assert.match(kiosk, /This software acceptance does not claim live RFID, NFC, QR camera, R503, or Pi validation/);
  assert.match(kiosk, /owner-only active-roster cache/);
  assert.match(kiosk, /Authentication maintenance/);
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

test("kiosk authentication migration is additive and keeps fingerprint as the upgrade default", async () => {
  const migration = await readFile("apps/api/migrations/0050_kiosk_auth_methods.sql", "utf8");
  assert.match(migration, /ALTER TABLE organization_settings ADD COLUMN kiosk_authentication_method/);
  assert.match(migration, /ALTER TABLE kiosks ADD COLUMN authentication_method/);
  assert.equal((migration.match(/DEFAULT 'fingerprint'/g) ?? []).length, 2);
  for (const method of ["fingerprint", "rfid", "nfc", "member_id", "qr"]) assert.match(migration, new RegExp(`'${method}'`));
  assert.doesNotMatch(migration, /credential|token|secret|digest|template/i);
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
  assert.match(source, /const backupSchemaVersion = 34;/);
  assert.match(source, /legacyTableColumns:[\s\S]*organization_settings: tableColumns\.organization_settings\.slice\(0, -12\)/);
  for (const [version, omitted] of [[8, 10], [9, 8], [10, 6], [15, 3]]) assert.match(source, new RegExp(`schemaVersion < ${version} && table === "organization_settings" \\? tableColumns\\.organization_settings\\.slice\\(0, -${omitted}\\)`));
  assert.match(source, /schemaVersion < 31 && table === "organization_settings" \? tableColumns\.organization_settings\.slice\(0, -1\)/);
  assert.match(source, /Number\(value\.schemaVersion\) < 1 \|\| Number\(value\.schemaVersion\) > backupSchemaVersion/);
  assert.match(source, /legacy-restore-checkout:/);
  assert.match(source, /late_scan_minutes: 30, logo_backdrop: "auto"/);
  assert.match(source, /attendance_reporting_starts_on: null, anomaly_late_threshold_minutes: DEFAULT_ANOMALY_THRESHOLD_MINUTES, anomaly_early_threshold_minutes: DEFAULT_ANOMALY_THRESHOLD_MINUTES/);
  assert.match(source, /recurrence_frequency: null/);
  assert.match(source, /deleted_at: null/);
  assert.match(source, /weight_category_id: null, weight_category_name: null, attendance_weight: 1/);
  assert.match(source, /google_enabled: providers\.has\("google"\) \? 1 : 0/);
  assert.match(source, /google_calendar_enabled: 0/);
});

test("Google Calendar migration and worker keep delivery scoped and retryable", async () => {
  const migration = await readFile("apps/api/migrations/0026_google_calendar_sync.sql", "utf8");
  const source = await readFile("apps/api/src/index.ts", "utf8");
  assert.match(migration, /google_calendar_authorizations/);
  assert.match(migration, /google_calendar_event_mappings/);
  assert.match(migration, /google_calendar_operations/);
  const discordCalendarMigration = await readFile("apps/api/migrations/0028_discord_calendar_delivery.sql", "utf8");
  assert.match(discordCalendarMigration, /discord_calendar_event_mappings/);
  assert.match(discordCalendarMigration, /discord_calendar_operations/);
  assert.match(discordCalendarMigration, /CHECK \(action IN \('upsert', 'delete'\)\)/);
  assert.match(discordCalendarMigration, /status IN \('pending', 'processing', 'delivered', 'failed'\)/);
  assert.match(discordCalendarMigration, /lease_token TEXT/);
  assert.match(discordCalendarMigration, /lease_expires_at TEXT/);
  assert.match(discordCalendarMigration, /revision INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /action IN \('upsert', 'delete'\)/);
  assert.match(source, /summary: meeting.title, description: calendarAttendanceDetails\(meeting, await meetingAudienceText\(db, operation.meetingId\)\)/);
  assert.match(source, /Google Calendar delivery retries safely on the next scheduled pass/);
  assert.match(source, /enqueueGoogleCalendarDelete/);
  assert.match(source, /enqueueGoogleCalendarRestore/);
  assert.doesNotMatch(source, /summary: operation\.(title|notes)/);
});

test("Discord absence recipient history preserves every sent notice", async () => {
  const migration = await readFile("apps/api/migrations/0011_discord_notice_history.sql", "utf8");
  assert.match(migration, /PRIMARY KEY \(installation_id, meeting_id, member_id, message_id\)/);
  assert.match(migration, /idx_discord_attendance_recipients_message/);
});

test("Discord contest notices have a bounded organization-wide expiry", async () => {
  const migration = await readFile("apps/api/migrations/0012_discord_contest_window.sql", "utf8");
  const source = await readFile("apps/api/src/index.ts", "utf8");
  assert.match(migration, /DEFAULT 24 CHECK \(discord_contest_window_hours BETWEEN 1 AND 168\)/);
  assert.match(source, /Date\.parse\(recipient\.deliveredAt\).+discordContestWindowHours/);
});

test("Discord channel manager migration tracks only owned messages and expiry state", async () => {
  const migration = await readFile("apps/api/migrations/0022_discord_channel_manager.sql", "utf8");
  assert.match(migration, /discord_channel_manager_enabled INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN channel_id TEXT/);
  assert.match(migration, /ADD COLUMN expires_at TEXT/);
  assert.match(migration, /ADD COLUMN deleted_at TEXT/);
  assert.match(migration, /idx_discord_attendance_notifications_expiry/);
  assert.doesNotMatch(migration, /fingerprint|biometric/i);
});

test("Discord attendance thread creation is tracked for retry", async () => {
  const migration = await readFile("apps/api/migrations/0033_discord_attendance_threads.sql", "utf8");
  assert.match(migration, /ADD COLUMN thread_created_at TEXT/);
});

test("attendance anomaly thresholds migrate with safe ten-minute defaults", async () => {
  const migration = await readFile("apps/api/migrations/0023_attendance_anomaly_thresholds.sql", "utf8");
  assert.match(migration, /anomaly_late_threshold_minutes INTEGER NOT NULL DEFAULT 10/);
  assert.match(migration, /anomaly_early_threshold_minutes INTEGER NOT NULL DEFAULT 10/);
  assert.equal((migration.match(/BETWEEN 0 AND 1440/g) ?? []).length, 2);
});

test("Discord anomaly reports migrate with private-channel configuration and retry state", async () => {
  const migration = await readFile("apps/api/migrations/0024_discord_anomaly_reports.sql", "utf8");
  assert.match(migration, /discord_anomaly_reports_enabled INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /discord_anomaly_report_channel_id TEXT/);
  assert.match(migration, /discord_anomaly_reports_enabled_at TEXT/);
  assert.match(migration, /CREATE TABLE discord_anomaly_reports/);
  assert.match(migration, /status IN \('pending', 'delivered', 'no_anomalies', 'failed'\)/);
  assert.match(migration, /length\(nonce\) BETWEEN 1 AND 25/);
  assert.doesNotMatch(migration, /fingerprint|biometric/i);
});

test("meeting weights migrate as bounded categories and stable per-meeting snapshots", async () => {
  const migration = await readFile("apps/api/migrations/0025_meeting_weights.sql", "utf8");
  assert.match(migration, /CREATE TABLE meeting_weight_categories/);
  assert.match(migration, /weight BETWEEN 0\.1 AND 100/);
  assert.match(migration, /minimum_duration_minutes BETWEEN 1 AND 10080/);
  assert.match(migration, /ADD COLUMN weight_category_id/);
  assert.match(migration, /ADD COLUMN weight_category_name/);
  assert.match(migration, /attendance_weight REAL NOT NULL DEFAULT 1/);
  assert.doesNotMatch(migration, /fingerprint|biometric/i);
});

test("recurring meeting migration stores series metadata without biometric data", async () => {
  const migration = await readFile("apps/api/migrations/0006_recurring_meetings.sql", "utf8");
  assert.match(migration, /recurrence_frequency/);
  assert.match(migration, /idx_meetings_series/);
  assert.doesNotMatch(migration, /fingerprint|template|biometric/i);
});

test("meeting-template migration stores only reusable scheduling defaults", async () => {
  const migration = await readFile("apps/api/migrations/0017_meeting_templates.sql", "utf8");
  assert.match(migration, /CREATE TABLE meeting_templates/);
  assert.match(migration, /duration_minutes/);
  assert.match(migration, /recurrence_duration_days/);
  assert.match(migration, /installation_id/);
  assert.doesNotMatch(migration, /fingerprint|biometric/i);
});

test("integration verification migration stores only proof state and hashed challenges", async () => {
  const migration = await readFile("apps/api/migrations/0007_integration_verification.sql", "utf8");
  assert.match(migration, /verified_at TEXT/);
  assert.match(migration, /challenge_hash TEXT NOT NULL/);
  assert.match(migration, /idx_integration_verification_expiry/);
  assert.doesNotMatch(migration, /raw_ip|fingerprint|template|biometric/i);
});

test("integration enablement migration preserves configured providers and defaults new providers off", async () => {
  const migration = await readFile("apps/api/migrations/0021_integration_enablement.sql", "utf8");
  assert.match(migration, /google_enabled INTEGER NOT NULL DEFAULT 0 CHECK/);
  assert.match(migration, /resend_enabled INTEGER NOT NULL DEFAULT 0 CHECK/);
  assert.match(migration, /discord_enabled INTEGER NOT NULL DEFAULT 0 CHECK/);
  for (const provider of ["google", "resend", "discord"]) assert.match(migration, new RegExp(`${provider}_enabled = EXISTS \\([\\s\\S]*provider = '${provider}'`));
  assert.doesNotMatch(migration, /ciphertext|iv|credential|secret/i);
});

test("entire-installation restore inserts roster members before linked dashboard users", async () => {
  const source = await readFile("apps/api/src/index.ts", "utf8");
  const order = source.match(/const installationTables: BackupTable\[\] = \[([\s\S]*?)\];/)?.[1] ?? "";
  assert.ok(order.indexOf('"members"') >= 0);
  assert.ok(order.indexOf('"users"') > order.indexOf('"members"'));
  assert.ok(order.indexOf('"meetings"') > order.indexOf('"users"'));
  assert.ok(order.indexOf('"meeting_weight_categories"') > order.indexOf('"users"'));
  assert.ok(order.indexOf('"meetings"') > order.indexOf('"meeting_weight_categories"'));
  assert.ok(order.indexOf('"attendance_events"') > order.indexOf('"meetings"'));
});

test("provisioning workflow is adopter-gated and account-neutral", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /Require a private deployment repository/);
  assert.match(workflow, /release:\s+[\s\S]*type: choice[\s\S]*- latest stable[\s\S]*- original template release/);
  assert.doesNotMatch(workflow, /release_tag:\s/);
  assert.match(workflow, /gh api repos\/isriah\/LancerLogin\/releases\/latest --jq \.tag_name/);
  assert.match(workflow, /ref: \$\{\{ steps\.release\.outputs\.sha \}\}/);
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

test("CI scopes ordinary changes and runs one complete exact-release gate", async () => {
  const packageDocument = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageDocument.scripts["verify:migrations"], "node scripts/verify-d1-migrations.mjs && node scripts/rehearse-community-upgrade.mjs");
  assert.match(packageDocument.scripts["verify:all"], /verify:migrations.*typecheck.*test.*build/);
  assert.match(packageDocument.scripts["verify:release"], /verify:all.*audit:release:local/);
  assert.equal(packageDocument.scripts["test:release-ci"], "npm run test:web && node --test tests/kiosk-runtime.test.mjs tests/kiosk-reassociation.test.mjs");
  assert.equal(packageDocument.scripts["verify:release-ci"], "npm run verify:migrations && npm run typecheck && npm run test:release-ci && npm run build");
  assert.doesNotMatch(packageDocument.scripts["test:release-ci"], /kiosk-artifacts/);
  assert.equal(packageDocument.scripts["audit:release"], "node scripts/audit-dependencies.mjs");
  assert.equal(packageDocument.scripts["audit:release:local"], "node scripts/audit-dependencies.mjs --defer-transient-to-ci");
  const audit = await readFile("scripts/audit-dependencies.mjs", "utf8");
  assert.match(audit, /"audit",[\s\S]*"--package-lock-only",[\s\S]*"--audit-level=high"/);
  assert.match(audit, /--fetch-timeout=30000/);
  assert.match(audit, /--fetch-retries=0/);
  assert.match(audit, /timeoutMs = 120_000/);
  assert.match(audit, /attemptTimeoutMs = 35_000/);
  assert.match(audit, /maxAttempts = 3/);
  assert.match(audit, /transientFailure/);
  assert.match(audit, /retrying/);
  assert.match(audit, /allowTransientDefer/);
  assert.match(audit, /exact commit in GitHub Verify/);
  const verifier = await readFile("scripts/verify-d1-migrations.mjs", "utf8");
  assert.match(verifier, /d1", "migrations", "apply"/);
  assert.match(verifier, /"--local"/);
  assert.match(verifier, /SELECT name FROM d1_migrations/);
  assert.match(verifier, /fingerprint_template\|raw_fingerprint\|biometric_template/);
  assert.doesNotMatch(verifier, /--remote|CLOUDFLARE_API_TOKEN/);
  const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(ciWorkflow, /Select verification scope/);
  assert.match(ciWorkflow, /npm run verify:dev/);
  assert.match(ciWorkflow, /npm run verify:kiosk/);
  assert.match(ciWorkflow, /npm run verify:release-ci/);
  assert.doesNotMatch(ciWorkflow, /npm run verify:all/);
  assert.match(ciWorkflow, /HEAD_COMMIT_MESSAGE.*Release\\ v\*/);
  assert.match(ciWorkflow, /outputs\.full == 'true'[\s\S]*kiosk-artifacts\.test\.mjs/);
  assert.match(ciWorkflow, /outputs\.full != 'true' && steps\.verification-scope\.outputs\.kiosk == 'true'/);
  assert.equal((ciWorkflow.match(/npm ci --no-audit/g) ?? []).length, 2);
  assert.match(ciWorkflow, /schedule:[\s\S]*cron:/);
  assert.match(ciWorkflow, /workflow_dispatch:/);
  assert.match(ciWorkflow, /dependency-audit:[\s\S]*npm run audit:release/);
  const dependencyAuditJob = ciWorkflow.match(/  dependency-audit:([\s\S]*?)  browser-shard:/)?.[1];
  assert.ok(dependencyAuditJob);
  assert.match(dependencyAuditJob, /node-version: 24/);
  assert.match(dependencyAuditJob, /npm ci --ignore-scripts --no-audit/);
  assert.match(dependencyAuditJob, /npm run audit:release/);
  assert.doesNotMatch(dependencyAuditJob, /audit:release:local/);
  assert.match(dependencyAuditJob, /dependency manifest changed/);
  assert.match(dependencyAuditJob, /HEAD_COMMIT_MESSAGE.*Release\\ v\*/);
  assert.match(ciWorkflow, /timeout-minutes: 20/);
  assert.match(ciWorkflow, /rhysd\/actionlint:1\.7\.12/);
  const browserShardJob = ciWorkflow.match(/  browser-shard:([\s\S]*?)  browser-smoke:/)?.[1];
  assert.ok(browserShardJob);
  assert.match(browserShardJob, /workflow_dispatch/);
  assert.match(browserShardJob, /startsWith\(github\.event\.head_commit\.message, 'Release v'\)/);
  assert.match(browserShardJob, /fail-fast: false/);
  assert.match(browserShardJob, /shard: \[1, 2, 3, 4\]/);
  assert.match(browserShardJob, /npm run test:browser -- --shard=\$\{\{ matrix\.shard \}\}\/4/);
  const browserGate = ciWorkflow.match(/  browser-smoke:([\s\S]*)$/)?.[1];
  assert.ok(browserGate);
  assert.match(browserGate, /needs: browser-shard/);
  assert.match(browserGate, /startsWith\(github\.event\.head_commit\.message, 'Release v'\)/);
  assert.match(browserGate, /test "\$SHARD_RESULT" = success/);
  assert.equal(packageDocument.scripts["test:browser"], "node scripts/run-browser-tests.mjs");
  const browserRunner = await readFile("scripts/run-browser-tests.mjs", "utf8");
  assert.match(browserRunner, /PWTEST_CACHE_DIR/);
  assert.match(browserRunner, /LANCERLOGIN_BROWSER_PORT_BASE/);
  const playwrightConfig = await readFile("playwright.config.ts", "utf8");
  assert.match(playwrightConfig, /LANCERLOGIN_BROWSER_PORT_BASE/);
  assert.match(playwrightConfig, /workers: process\.env\.CI \? 1 : undefined/);
  assert.doesNotMatch(playwrightConfig, /reuseExistingServer: true|reuseExistingServer: !process\.env\.CI/);
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(releaseWorkflow, /actions: read/);
  assert.match(releaseWorkflow, /contents: read/);
  assert.match(releaseWorkflow, /release-publication\.mjs resolve "\$RELEASE_TAG"/);
  assert.match(releaseWorkflow, /ref: \$\{\{ steps\.source\.outputs\.sha \}\}/);
  assert.match(releaseWorkflow, /--require-unprivileged/);
  assert.match(releaseWorkflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(releaseWorkflow, /contents: write|gh release|immutable-releases/);
  assert.doesNotMatch(releaseWorkflow, /npm (?:ci|test|audit)|npm run (?:verify:migrations|typecheck|build)/);
  const publisher = await readFile("scripts/release-publication.mjs", "utf8");
  assert.match(publisher, /actions\/workflows\/ci\.yml\/runs\?head_sha=/);
  assert.match(publisher, /run\.event !== "push"/);
  assert.match(publisher, /run\.head_branch !== branch/);
  assert.match(publisher, /assertLatestPromotion/);
  assert.match(publisher, /immutable-releases/);
  assert.match(publisher, /--notes-file/);
  assert.doesNotMatch(publisher, /--generate-notes/);
});
test("Cloudflare setup is adopter-guided and does not require a target account", async () => {
  const guide = await readFile("docs/CLOUDFLARE-LINKING.md", "utf8");
  assert.match(guide, /adopter's own Cloudflare account/i);
  assert.match(guide, /CLOUDFLARE_API_TOKEN/);
  assert.match(guide, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(guide, /Account Settings Read/);
  assert.doesNotMatch(guide, /account_id\s*=|database_id\s*=/i);
});
