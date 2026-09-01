import test from "node:test";
import assert from "node:assert/strict";
import { buildProvisionConfig } from "../scripts/prepare-cloudflare-provision.mjs";
import { resourceExists } from "../scripts/cloudflare-resource-state.mjs";
import { selectCloudflareAccount } from "../scripts/select-cloudflare-account.mjs";

test("token-only setup selects exactly one scoped Cloudflare account", () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  assert.equal(selectCloudflareAccount({ success: true, result: [{ id: accountId, name: "Adopter account" }] }), accountId);
  assert.throws(() => selectCloudflareAccount({ success: true, result: [] }), /exactly one/);
  assert.throws(() => selectCloudflareAccount({ success: true, result: [{ id: accountId }, { id: "f".repeat(32) }] }), /exactly one/);
  assert.throws(() => selectCloudflareAccount({ success: false, result: [] }), /discovery failed/);
});

test("generated Worker configuration is account-neutral until D1 discovery", () => {
  const missing = buildProvisionConfig("example-club", [], "1.2.3");
  assert.equal(missing.state, "missing");
  assert.equal("d1_databases" in missing.config, false);
  assert.equal(missing.config.vars.ALLOWED_ORIGIN, "https://example-club-dashboard.pages.dev");
  assert.equal(missing.config.vars.RELEASE_VERSION, "1.2.3");
  assert.equal(missing.config.vars.TELEMETRY_ENDPOINT, "https://lancerlogin-community-telemetry.robolancers.workers.dev/v1/report");
  assert.deepEqual(missing.config.triggers.crons, ["*/5 * * * *", "0 3 * * *"]);
  assert.throws(() => buildProvisionConfig("example-club", [], "latest"), /Invalid release version/);
});

test("existing adopter D1 is bound after discovery", () => {
  const found = buildProvisionConfig("example-club", [{ name: "example-club-data", uuid: "fresh-adopter-database" }]);
  assert.equal(found.state, "exists");
  assert.deepEqual(found.config.d1_databases, [{ binding: "DB", database_name: "example-club-data", database_id: "fresh-adopter-database", migrations_dir: "../apps/api/migrations" }]);
});

test("generated Worker configuration records only a validated private updater URL", () => {
  const prior = process.env.LANCERLOGIN_UPDATE_WORKFLOW_URL;
  try {
    process.env.LANCERLOGIN_UPDATE_WORKFLOW_URL = "https://github.com/example/private-deployment/actions/workflows/provision-template.yml";
    const result = buildProvisionConfig("example-club", [], "1.2.3");
    assert.equal(result.config.vars.UPDATE_WORKFLOW_URL, process.env.LANCERLOGIN_UPDATE_WORKFLOW_URL);
    process.env.LANCERLOGIN_UPDATE_WORKFLOW_URL = "https://hostile.example.test/update";
    assert.throws(() => buildProvisionConfig("example-club", [], "1.2.3"), /Invalid private deployment workflow URL/);
  } finally {
    if (prior === undefined) delete process.env.LANCERLOGIN_UPDATE_WORKFLOW_URL;
    else process.env.LANCERLOGIN_UPDATE_WORKFLOW_URL = prior;
  }
});

test("Pages project discovery is resumable", () => {
  assert.equal(resourceExists("pages", "example-club-dashboard", [{ name: "example-club-dashboard" }]), true);
  assert.equal(resourceExists("pages", "other-dashboard", [{ name: "example-club-dashboard" }]), false);
});
