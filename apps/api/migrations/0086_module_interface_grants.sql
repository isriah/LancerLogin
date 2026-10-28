-- Module interface grants. An Admin lets one module call operations of another module's interface without a signed-in
-- user, for example from a scheduled job or a public request. Core rechecks the active grant in the same batch as every
-- statement the call runs, so revoking it stops the next write at once.
-- A grant covers exactly the operations the consumer declared when it was granted, at that interface version.
-- Not portable: backups leave grants out, an installation restore or Delete installation removes them with the
-- installation row, and Core deletes them when either module's retained data is deleted. Revoked rows stay as history.
-- Additive: the previously deployed Worker never reads or writes this table.
CREATE TABLE platform_module_interface_grants (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  consumer_module_id TEXT NOT NULL CHECK(length(consumer_module_id) BETWEEN 1 AND 64),
  provider_module_id TEXT NOT NULL CHECK(length(provider_module_id) BETWEEN 1 AND 64),
  interface_id TEXT NOT NULL CHECK(length(interface_id) BETWEEN 3 AND 80),
  interface_version INTEGER NOT NULL CHECK(typeof(interface_version) = 'integer' AND interface_version >= 1),
  operations_json TEXT NOT NULL CHECK(json_valid(operations_json) AND json_type(operations_json) = 'array' AND json_array_length(operations_json) >= 1),
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY(installation_id, id),
  CHECK(consumer_module_id <> provider_module_id),
  CHECK(revoked_by IS NULL OR revoked_at IS NOT NULL)
);
-- At most one active grant per consumer, interface and version.
CREATE UNIQUE INDEX platform_module_interface_grants_active
  ON platform_module_interface_grants(installation_id, consumer_module_id, interface_id, interface_version) WHERE revoked_at IS NULL;
CREATE INDEX platform_module_interface_grants_provider ON platform_module_interface_grants(installation_id, provider_module_id);
