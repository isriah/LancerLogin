import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  assert.equal("TELEMETRY_ENDPOINT" in missing.config.vars, false);
  assert.deepEqual(missing.config.triggers.crons, ["*/5 * * * *"]);
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

test("generated Worker configuration runs near D1 with Smart Placement or a validated placement hint", () => {
  const prior = process.env.LANCERLOGIN_WORKER_PLACEMENT_REGION;
  const placement = () => buildProvisionConfig("example-club", [], "1.2.3").config.placement;
  try {
    delete process.env.LANCERLOGIN_WORKER_PLACEMENT_REGION;
    assert.deepEqual(placement(), { mode: "smart" });
    // An unset GitHub variable reaches the job environment as an empty string.
    process.env.LANCERLOGIN_WORKER_PLACEMENT_REGION = "";
    assert.deepEqual(placement(), { mode: "smart" });
    for (const region of ["aws:us-east-1", "gcp:us-east4", "azure:eastus2"]) {
      process.env.LANCERLOGIN_WORKER_PLACEMENT_REGION = region;
      assert.deepEqual(placement(), { region }, region);
    }
    for (const region of ["us-east-1", "aws:US-EAST-1", "oracle:us-east-1", "aws:", "aws:us east 1", "aws:us-east-1\n", "smart"]) {
      process.env.LANCERLOGIN_WORKER_PLACEMENT_REGION = region;
      assert.throws(placement, /Invalid Worker placement region: set LANCERLOGIN_WORKER_PLACEMENT_REGION/, JSON.stringify(region));
    }
  } finally {
    if (prior === undefined) delete process.env.LANCERLOGIN_WORKER_PLACEMENT_REGION;
    else process.env.LANCERLOGIN_WORKER_PLACEMENT_REGION = prior;
  }
});

test("the provisioning script writes the placement the workflow deploys and refuses an invalid hint", async () => {
  const work = await mkdtemp(join(tmpdir(), "lancerlogin-provision-placement-"));
  const script = resolve("scripts/prepare-cloudflare-provision.mjs");
  const run = (region) => {
    const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...(region === undefined ? {} : { LANCERLOGIN_WORKER_PLACEMENT_REGION: region }) };
    return spawnSync(process.execPath, [script, "example-club"], { cwd: work, env: environment, encoding: "utf8", timeout: 30_000 });
  };
  const written = async () => JSON.parse(await readFile(join(work, ".provision/wrangler.json"), "utf8")).placement;
  try {
    assert.equal(run(undefined).status, 0);
    assert.deepEqual(await written(), { mode: "smart" });
    assert.equal(run("gcp:us-east4").status, 0);
    assert.deepEqual(await written(), { region: "gcp:us-east4" });
    await rm(join(work, ".provision"), { recursive: true, force: true });
    const refused = run("us-east-1");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Invalid Worker placement region/);
    assert.equal(existsSync(join(work, ".provision/wrangler.json")), false, "no configuration is written for an invalid hint");
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("Pages project discovery is resumable", () => {
  assert.equal(resourceExists("pages", "example-club-dashboard", [{ name: "example-club-dashboard" }]), true);
  assert.equal(resourceExists("pages", "other-dashboard", [{ name: "example-club-dashboard" }]), false);
});

test("renamed installation retains its independently fixed database identity", () => {
  const database = { name: "original-data", uuid: "11111111-1111-1111-1111-111111111111" };
  const result = buildProvisionConfig("renamed", [database], "1.0.3", "original-data");
  assert.equal(result.state, "exists");
  assert.equal(result.config.name, "renamed-api");
  assert.equal(result.config.d1_databases[0].database_name, "original-data");
  assert.equal(result.config.d1_databases[0].database_id, database.uuid);
  assert.equal(buildProvisionConfig("renamed", [{ ...database, name: "renamed-data" }], "1.0.3", "original-data").state, "missing");
  assert.throws(() => buildProvisionConfig("renamed", [database], "1.0.3", "../original-data"), /fixed_database_name_invalid/);
});
