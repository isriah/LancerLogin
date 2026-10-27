import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ensureFingerprintVaultKey, installFingerprintVaultKey, fingerprintVaultSecretName, fingerprintVaultStateSql } from "../scripts/ensure-fingerprint-vault-key.mjs";

const env = { REPOSITORY_PRIVATE: "true", INSTALLATION_SLUG: "example", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "cfat_synthetic", WEB_UPDATE_CONFIG: ".provision/wrangler.json" };
const databaseId = "22222222-2222-2222-2222-222222222222";
const config = { name: "example-api", d1_databases: [{ binding: "DB", database_id: databaseId }] };

test("existing vault key is retained without reading templates or uploading secrets", async () => {
  const result = await ensureFingerprintVaultKey({ listSecretNames: async () => [fingerprintVaultSecretName], readVaultState: () => assert.fail("no state read needed"), putSecret: () => assert.fail("must not rotate") });
  assert.deepEqual(result, { status: "retained" });
});

test("new disabled empty vault gets one canonical independent 32-byte key", async () => {
  const names = []; let writes = 0;
  const io = { listSecretNames: async () => names, readVaultState: async () => ({ enabled: 0, stored: 0 }), putSecret: async (name, value) => {
    assert.equal(name, fingerprintVaultSecretName); assert.match(value, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(value, "base64url").length, 32);
    writes++; names.push(name);
  } };
  assert.deepEqual(await ensureFingerprintVaultKey(io), { status: "created" });
  assert.deepEqual(await ensureFingerprintVaultKey(io), { status: "retained" }); assert.equal(writes, 1);
});

test("missing original key with enabled storage or surviving templates fails closed", async () => {
  for (const state of [{ enabled: 1, stored: 0 }, { enabled: 0, stored: 1 }, { enabled: 1, stored: 20 }]) {
    await assert.rejects(ensureFingerprintVaultKey({ listSecretNames: async () => [], readVaultState: async () => state, putSecret: () => assert.fail("cannot replace a lost key") }), /vault_original_key_recovery_required/);
  }
});

test("unknown metadata, unavailable state and uncertain upload cannot pass", async () => {
  for (const state of [undefined, {}, { enabled: 2, stored: 0 }, { enabled: "0", stored: 0 }, { enabled: 0, stored: -1 }, { enabled: 0, stored: 0.5 }]) {
    await assert.rejects(ensureFingerprintVaultKey({ listSecretNames: async () => [], readVaultState: async () => state, putSecret: () => assert.fail("invalid state cannot authorize a key") }), /vault_state_unavailable/);
  }
  await assert.rejects(ensureFingerprintVaultKey({ listSecretNames: async () => undefined }), /vault_secret_metadata_invalid/);
  await assert.rejects(ensureFingerprintVaultKey({ listSecretNames: async () => [], readVaultState: async () => ({ enabled: 0, stored: 0 }), putSecret: async () => {} }), /vault_secret_write_unconfirmed/);
});

function adapterHarness(state = { enabled: 0, stored: 0 }) {
  const requests = []; const calls = []; const names = [];
  return { requests, calls, dependencies: {
    readConfig: async () => JSON.stringify(config),
    request: async (url, init) => {
      requests.push({ url, init });
      const result = url.endsWith("/tokens/verify") ? { status: "active" } : url.endsWith("/settings") ? { bindings: [{ name: "DB", type: "d1", id: databaseId }] } : url.endsWith("/query") ? [{ success: true, results: [state] }] : { uuid: databaseId, name: "example-data" };
      return Response.json({ success: true, result });
    },
    runWrangler: async (args, target, input) => {
      calls.push({ args, target, hasInput: input !== undefined });
      if (args[1] === "put") {
        assert.equal(args[2], fingerprintVaultSecretName); assert.match(input, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(args.some((arg) => arg.includes(input)), false); assert.equal(JSON.stringify(target).includes(input), false);
        names.push(fingerprintVaultSecretName); return "";
      }
      return JSON.stringify(names.map((name) => ({ name })));
    },
  } };
}

test("CLI validates fixed account, database and Worker before key upload via stdin only", async () => {
  const harness = adapterHarness();
  assert.deepEqual(await installFingerprintVaultKey(env, harness.dependencies), { status: "created" });
  assert.equal(harness.requests.length, 4); assert.equal(harness.calls.filter((call) => call.hasInput).length, 1);
  const query = harness.requests.at(-1);
  assert.equal(query.init.method, "POST"); assert.equal(query.init.redirect, "error");
  assert.deepEqual(JSON.parse(query.init.body), { sql: fingerprintVaultStateSql });
  assert.match(query.url, new RegExp(`/d1/database/${databaseId}/query$`));
});

test("CLI recovery and resource mismatches never upload a replacement key", async () => {
  const enabled = adapterHarness({ enabled: 1, stored: 3 });
  await assert.rejects(installFingerprintVaultKey(env, enabled.dependencies), /vault_original_key_recovery_required/);
  assert.equal(enabled.calls.some((call) => call.hasInput), false);
  const harness = adapterHarness();
  await assert.rejects(installFingerprintVaultKey({ ...env, REPOSITORY_PRIVATE: "false" }, harness.dependencies), /private_installation_required/);
  await assert.rejects(installFingerprintVaultKey(env, { ...harness.dependencies, readConfig: async () => JSON.stringify({ ...config, name: "other-api" }) }), /fixed_worker_configuration_required/);
  await assert.rejects(installFingerprintVaultKey(env, { ...harness.dependencies, request: async () => new Response(null, { status: 401 }) }), /credential_target_unavailable/);
  assert.equal(harness.calls.length, 0);
});

test("install and update controller prepare the separate key after migrations and before completion", async () => {
  const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
  const preparation = workflow.indexOf("            node scripts/ensure-fingerprint-vault-key.mjs");
  assert.ok(preparation > workflow.indexOf("if [ -f scripts/ensure-fingerprint-vault-key.mjs ]; then"));
  assert.ok(preparation > workflow.indexOf("name: Apply D1 migrations"));
  assert.ok(preparation > workflow.indexOf("name: Deploy existing Worker API"));
  assert.ok(preparation < workflow.indexOf("name: Publish setup links"));
  const controller = await readFile("scripts/run-web-upgrade.mjs", "utf8");
  assert.match(controller, /async migrate\(\) \{[\s\S]*migrations[\s\S]*await ensureFingerprintVaultKey/);
  assert.match(controller, /putSecret: \(name, value\) => wrangler\(\["secret", "put", name\], \{ input: value \}\)/);
  assert.match(controller, /fingerprintVaultSecretName\].every\(\(name\) => secrets.has\(name\)\)/);
});
