import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildTelemetryCollectorConfig } from "../scripts/prepare-telemetry-collector.mjs";

test("collector configuration stays account-neutral until D1 discovery", () => {
  const missing = buildTelemetryCollectorConfig([]);
  assert.equal(missing.state, "missing");
  assert.equal("d1_databases" in missing.config, false);
  assert.deepEqual(missing.config.observability, { enabled: false });
  assert.deepEqual(missing.config.ratelimits.map((entry) => entry.name), ["GLOBAL_LIMITER", "INSTALL_LIMITER"]);
  assert.doesNotMatch(JSON.stringify(missing.config), /account_id|api[_-]?token|secret/i);
});

test("collector generator binds only the separately discovered database", () => {
  const found = buildTelemetryCollectorConfig([{ name: "lancerlogin-community-telemetry", uuid: "new-collector-database" }], { globalNamespaceId: "88001", installNamespaceId: "88002" });
  assert.equal(found.state, "exists");
  assert.deepEqual(found.config.d1_databases, [{ binding: "DB", database_name: "lancerlogin-community-telemetry", database_id: "new-collector-database", migrations_dir: "../apps/telemetry-collector/migrations" }]);
  assert.throws(() => buildTelemetryCollectorConfig([], { globalNamespaceId: "1", installNamespaceId: "1" }), /different/);
});

test("collector schema contains only allowlisted telemetry fields", async () => {
  const schema = await readFile("apps/telemetry-collector/migrations/0001_initial.sql", "utf8");
  assert.match(schema, /install_hash/);
  assert.match(schema, /active_kiosk_count/);
  assert.doesNotMatch(schema, /organization_name|member_id|attendance_event|fingerprint_|credential_|request_header|raw_ip/i);
});
