import test from "node:test";
import assert from "node:assert/strict";
import { parseD1MaintenanceArgs, wranglerD1Args } from "../scripts/d1-maintenance.mjs";
import { discoverCloudflareAccount } from "../scripts/select-cloudflare-account.mjs";

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

test("Cloudflare account discovery rejects ambiguous tokens without exposing them", async () => {
  await assert.rejects(
    discoverCloudflareAccount("secret-value", async () => ({ ok: true, json: async () => ({ success: true, result: [] }) })),
    /exactly one Cloudflare account/,
  );
  await assert.rejects(discoverCloudflareAccount("secret-value", async () => { throw new Error("secret-value"); }), /Could not reach Cloudflare/);
});
