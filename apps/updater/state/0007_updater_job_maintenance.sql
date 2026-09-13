-- Independent updater D1 only. No time-based expiry of execution ownership.
CREATE TABLE updater_job_maintenance (
  installation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
);
CREATE TABLE updater_job_holds (
  hold_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  operation_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','released'))
);
CREATE INDEX updater_job_holds_active ON updater_job_holds(installation_id,job_id) WHERE state='active';
