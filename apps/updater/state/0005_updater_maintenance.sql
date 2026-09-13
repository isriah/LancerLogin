-- Independent updater D1 only. Never restore these tables from application data.
CREATE TABLE updater_maintenance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'draining', 'closed')),
  job_id TEXT
);
CREATE TABLE updater_execution_permits (
  permit_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'released'))
);
CREATE INDEX updater_active_permits ON updater_execution_permits(installation_id, permit_id) WHERE state = 'active';
CREATE TABLE updater_execution_operations (
  operation_id TEXT PRIMARY KEY,
  permit_id TEXT NOT NULL REFERENCES updater_execution_permits(permit_id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete'))
);
CREATE INDEX updater_pending_operations ON updater_execution_operations(permit_id, operation_id) WHERE state = 'pending';
