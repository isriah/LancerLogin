-- Core's shared Notion connection (services.notion). An Admin saves one Notion integration token for the installation
-- and chooses, for each database a module declared, which Notion database that module may use.
-- Additive: the previously deployed Worker never reads these tables. Both travel in entire-installation backups
-- (schema 53); a restore leaves paused_until_ms at 0.

-- The one Notion connection. The token is encrypted with Core's integration key; only its ciphertext and IV are stored.
-- enabled 0 keeps the token but refuses every call. bot_name and workspace_name are what Notion reported at the last
-- check, shown to Admins. capabilities_json records what the token has been seen to allow (read, insert, update,
-- comment, users, email: ok or refused; a missing key is unknown). paused_until_ms holds every module's calls after
-- Notion rate limits one of them. key_version counts token saves; revision counts every change.
CREATE TABLE notion_connection (
  installation_id TEXT NOT NULL PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 4000),
  iv TEXT NOT NULL CHECK (length(iv) BETWEEN 1 AND 200),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(key_version) = 'integer' AND key_version >= 1),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  bot_name TEXT NOT NULL DEFAULT '' CHECK (length(bot_name) <= 200),
  workspace_name TEXT NOT NULL DEFAULT '' CHECK (length(workspace_name) <= 200),
  checked_at TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (length(capabilities_json) <= 1000 AND json_valid(capabilities_json)),
  paused_until_ms INTEGER NOT NULL DEFAULT 0 CHECK (typeof(paused_until_ms) = 'integer' AND paused_until_ms >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
  updated_at TEXT NOT NULL
);

-- The Notion database an Admin chose for one binding a module declared in its manifest. database_id is the database
-- the Admin linked and data_source_id the data source inside it that calls use; name is the data source's name when it
-- was chosen. Removing the connection keeps these rows; deleting a module's data removes its rows.
CREATE TABLE notion_bindings (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK (length(module_id) BETWEEN 1 AND 64),
  binding_id TEXT NOT NULL CHECK (length(binding_id) BETWEEN 1 AND 40),
  database_id TEXT NOT NULL CHECK (length(database_id) = 36),
  data_source_id TEXT NOT NULL CHECK (length(data_source_id) = 36),
  name TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, module_id, binding_id)
);
