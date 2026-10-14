-- Complete Attendance setup, revocation, and bounded retained-data cleanup.
ALTER TABLE platform_modules ADD COLUMN deletion_cursor INTEGER NOT NULL DEFAULT 0
CHECK(typeof(deletion_cursor) = 'integer' AND deletion_cursor >= 0);
ALTER TABLE platform_modules ADD COLUMN cleanup_failure TEXT
CHECK(cleanup_failure IS NULL OR cleanup_failure = 'retry-required');

CREATE TABLE platform_module_setup_progress (
  installation_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  setup_version INTEGER NOT NULL CHECK(typeof(setup_version) = 'integer' AND setup_version >= 1),
  outcome TEXT NOT NULL CHECK(outcome IN ('completed', 'skipped')),
  completed_at TEXT NOT NULL,
  completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY(installation_id, module_id, step_id),
  FOREIGN KEY(installation_id, module_id) REFERENCES platform_modules(installation_id, module_id) ON DELETE CASCADE
);

CREATE TABLE platform_module_cleanup_leases (
  installation_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation >= 1 AND generation < 9007199254740991),
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, module_id),
  FOREIGN KEY(installation_id, module_id) REFERENCES platform_modules(installation_id, module_id) ON DELETE CASCADE
);

UPDATE platform_modules
SET setup_version = 2
WHERE module_id = 'attendance';

-- Upgraded Community installations stay ready. Fresh installations are added
-- by bootstrap after this migration and must complete the new module setup.
INSERT INTO platform_module_setup_progress(
  installation_id, module_id, step_id, setup_version, outcome, completed_at, completed_by
)
SELECT m.installation_id, m.module_id, step.value, 2,
  CASE WHEN step.value IN ('calendar', 'discord') THEN 'skipped' ELSE 'completed' END,
  i.created_at,
  (SELECT id FROM users WHERE installation_id = m.installation_id AND role = 'admin' ORDER BY created_at, id LIMIT 1)
FROM platform_modules m
JOIN installations i ON i.id = m.installation_id,
json_each('["rules","meeting","input","calendar","discord"]') step
WHERE m.module_id = 'attendance' AND m.setup_complete = 1;
