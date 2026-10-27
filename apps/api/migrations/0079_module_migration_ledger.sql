-- Applied migrations of installed modules, recorded per module after Core migrations.
-- Like d1_migrations this is operational schema state, not portable installation
-- data: it has no installation key or foreign key, so deleting or restoring
-- installation data cannot erase the record of schema that still exists.
-- Sequence 0 records an adopted baseline of historical Core migrations that already
-- created the module's schema; sequence N records the module's own NNNN_name.sql.
CREATE TABLE platform_module_migrations (
  module_id TEXT NOT NULL CHECK(length(module_id) BETWEEN 1 AND 64 AND module_id GLOB '[a-z]*' AND module_id NOT GLOB '*[^a-z0-9-]*'),
  sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence >= 0 AND sequence <= 9999),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL CHECK(julianday(applied_at) IS NOT NULL),
  PRIMARY KEY(module_id, sequence),
  UNIQUE(module_id, name),
  CHECK(
    (sequence = 0 AND name = 'adopted-baseline')
    OR
    (sequence >= 1 AND name GLOB '[0-9][0-9][0-9][0-9]_*.sql' AND name NOT GLOB '*[^a-z0-9_.]*' AND CAST(substr(name, 1, 4) AS INTEGER) = sequence)
  )
);
