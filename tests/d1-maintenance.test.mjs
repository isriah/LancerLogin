import test from "node:test";
import assert from "node:assert/strict";
import { parseD1MaintenanceArgs, wranglerD1Args } from "../scripts/d1-maintenance.mjs";
import { verifyCloudflareAccountToken } from "../scripts/select-cloudflare-account.mjs";

test("D1 maintenance builds a token-neutral backup command", () => {
  const config = parseD1MaintenanceArgs(["backup", "--database", "sample-club-data", "--output", "backup.sql"]);
  assert.equal(config.operation, "backup");
  assert.deepEqual(wranglerD1Args(config).slice(0, 5), ["wrangler", "d1", "export", "sample-club-data", "--remote"]);
  assert.doesNotMatch(wranglerD1Args(config).join(" "), /account/i);
});

test("D1 restore requires an exact destructive confirmation", () => {
  assert.throws(
    () => parseD1MaintenanceArgs(["restore", "--database", "sample-club-data", "--file", "backup.sql"]),
    /RESTORE sample-club-data/,
  );
  const config = parseD1MaintenanceArgs(["restore", "--database", "sample-club-data", "--file", "backup.sql", "--confirm", "RESTORE sample-club-data"]);
  assert.deepEqual(wranglerD1Args(config).slice(0, 5), ["wrangler", "d1", "execute", "sample-club-data", "--remote"]);
});

test("Cloudflare maintenance verifies the exact account-owned token without exposing it", async () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  let requestedUrl;
  assert.equal(await verifyCloudflareAccountToken("cfat_secret-value", accountId, async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ success: true, result: { status: "active" } }) };
  }), accountId);
  assert.equal(requestedUrl, `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`);
  await assert.rejects(verifyCloudflareAccountToken("cfat_secret-value", accountId, async () => { throw new Error("cfat_secret-value"); }), /Could not reach Cloudflare/);
  await assert.rejects(verifyCloudflareAccountToken("not-an-account-token", accountId), /Account API Token/);
});
