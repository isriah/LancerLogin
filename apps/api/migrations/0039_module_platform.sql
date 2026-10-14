-- Static optional-module state appended to the released Community migration chain.
CREATE TABLE platform_module_administration (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  selection_completed INTEGER NOT NULL DEFAULT 0 CHECK(selection_completed IN (0, 1))
);

-- Authority epochs intentionally omit installation foreign keys so deletion and
-- restore cannot revive an older module generation or configuration revision.
CREATE TABLE platform_module_administration_epochs (
  installation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991)
);

CREATE TABLE platform_module_epochs (
  installation_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation >= 1 AND generation < 9007199254740991),
  PRIMARY KEY(installation_id, module_id)
);

CREATE TABLE platform_modules (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK(typeof(contract_version) = 'integer' AND contract_version >= 1),
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation >= 1 AND generation < 9007199254740991),
  phase TEXT NOT NULL DEFAULT 'disabled' CHECK(phase IN ('disabled', 'enabled', 'retained', 'deleting', 'deleted')),
  setup_version INTEGER NOT NULL CHECK(typeof(setup_version) = 'integer' AND setup_version >= 1),
  setup_complete INTEGER NOT NULL DEFAULT 1 CHECK(setup_complete IN (0, 1)),
  disabled_at TEXT,
  delete_after TEXT,
  PRIMARY KEY(installation_id, module_id),
  CHECK(
    (phase IN ('disabled', 'enabled', 'deleted') AND disabled_at IS NULL AND delete_after IS NULL)
    OR
    (phase IN ('retained', 'deleting') AND disabled_at IS NOT NULL AND delete_after IS NOT NULL
      AND julianday(disabled_at) IS NOT NULL AND julianday(delete_after) = julianday(disabled_at) + 7)
  )
);
CREATE INDEX platform_modules_cleanup_due ON platform_modules(phase, delete_after, installation_id, module_id);

CREATE TABLE platform_module_assignment_epochs (
  installation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  PRIMARY KEY(installation_id, user_id)
);

CREATE TABLE platform_module_assignment_revisions (
  installation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  PRIMARY KEY(installation_id, user_id)
);

CREATE TABLE platform_module_assignments (
  installation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json) AND json_type(capabilities_json) = 'array'),
  PRIMARY KEY(installation_id, user_id, module_id),
  FOREIGN KEY(installation_id, module_id) REFERENCES platform_modules(installation_id, module_id) ON DELETE CASCADE
);

-- Existing Community installations retain Attendance and existing Operator access.
-- A fresh bootstrap creates an incomplete module selection separately in code.
INSERT INTO platform_module_administration(installation_id, revision, selection_completed)
  SELECT id, 0, 1 FROM installations;
INSERT INTO platform_module_administration_epochs(installation_id, revision)
  SELECT id, 0 FROM installations;
INSERT INTO platform_module_epochs(installation_id, module_id, generation)
  SELECT id, 'attendance', 1 FROM installations;
INSERT INTO platform_modules(installation_id, module_id, contract_version, generation, phase, setup_version, setup_complete)
  SELECT id, 'attendance', 1, 1, 'enabled', 1, 1 FROM installations;
INSERT INTO platform_module_assignment_epochs(installation_id, user_id, revision)
  SELECT installation_id, id, 0 FROM users;
INSERT INTO platform_module_assignment_revisions(installation_id, user_id, revision)
  SELECT installation_id, id, 0 FROM users;
INSERT INTO platform_module_assignments(installation_id, user_id, module_id, capabilities_json)
  SELECT installation_id, id, 'attendance', '["attendance.manage"]' FROM users WHERE role = 'operator';
