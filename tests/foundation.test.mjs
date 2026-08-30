import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { can } from "../packages/shared/src/policy.mjs";
import { createApiHarness } from "../apps/api/src/test-harness.mjs";

test("foundation documents state standalone constraints", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /standalone/i);
  assert.match(readme, /sensor/i);
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
});

test("provisioning workflow is adopter-gated and account-neutral", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /expected=.*inputs\.operation/);
  assert.match(workflow, /inputs\.confirmation.*expected.*inputs\.installation_slug/);
  assert.match(workflow, /RESUME|resume/);
  assert.match(workflow, /Generate installation session key\s+if: steps\.resources\.outputs\.worker == 'missing'/);
  assert.match(workflow, /Deploy existing Worker API without rotating secrets/);
  assert.match(workflow, /if: steps\.resources\.outputs\.worker == 'exists'/);
  assert.match(workflow, /VITE_API_BASE_URL: \/api/);
  assert.match(workflow, /prepare-pages-proxy\.mjs/);
  assert.equal((workflow.match(/secrets:\s*\|/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /accountId|account_id\s*[:=]/i);
});

test("Cloudflare setup is adopter-guided and does not require a target account", async () => {
  const guide = await readFile("docs/CLOUDFLARE-LINKING.md", "utf8");
  assert.match(guide, /adopter's own Cloudflare account/i);
  assert.match(guide, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(guide, /account_id\s*=|database_id\s*=/i);
});
