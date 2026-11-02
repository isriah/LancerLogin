-- The last refused or failed attempt to apply an installed module's migrations, so Settings > Modules can tell Admins that
-- the module's update did not finish. Written by module reconciliation and deleted once that module reconciles.
-- Additive: the previously deployed Worker never reads this table. Operational state: never part of portable backups.
CREATE TABLE platform_module_update_failures (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK(length(module_id) BETWEEN 1 AND 64),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64),
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
  first_failed_at TEXT NOT NULL CHECK(julianday(first_failed_at) IS NOT NULL),
  last_tried_at TEXT NOT NULL CHECK(julianday(last_tried_at) IS NOT NULL),
  PRIMARY KEY(installation_id, module_id)
);
