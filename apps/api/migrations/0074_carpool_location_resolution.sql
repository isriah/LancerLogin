-- Lookup execution authority is temporary and is not portable backup data.
CREATE TABLE carpool_location_resolution (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  input_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','complete','failed')),
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT CHECK(error_code IS NULL OR error_code IN ('provider','conflict','interrupted')),
  PRIMARY KEY(installation_id,plan_id),
  FOREIGN KEY(installation_id,plan_id) REFERENCES carpool_plans(installation_id,id) ON DELETE CASCADE,
  CHECK((state='running')=(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
