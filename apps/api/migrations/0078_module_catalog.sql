-- Definitions of installed module code, recorded by the Worker before a module can be enabled.
-- Retained data stays describable and deletable after a plugin's code is removed.
-- Operational state: never part of portable backups.
CREATE TABLE platform_module_catalog (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK(length(module_id) BETWEEN 1 AND 64),
  origin TEXT NOT NULL CHECK(origin IN ('first-party', 'external')),
  source TEXT CHECK(source IS NULL OR length(source) BETWEEN 1 AND 512),
  source_commit TEXT CHECK(source_commit IS NULL OR (length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*')),
  contract_version INTEGER NOT NULL CHECK(typeof(contract_version) = 'integer' AND contract_version >= 1),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json) AND json_type(definition_json) = 'object'),
  definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64 AND definition_sha256 NOT GLOB '*[^0-9a-f]*'),
  installed INTEGER NOT NULL CHECK(installed IN (0, 1)),
  recorded_at TEXT NOT NULL CHECK(julianday(recorded_at) IS NOT NULL),
  PRIMARY KEY(installation_id, module_id)
);
