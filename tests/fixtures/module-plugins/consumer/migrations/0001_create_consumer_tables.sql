-- Synthetic Consumer plugin schema: its settings and the outcome of each interface call its job made.
CREATE TABLE consumer_settings (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id)
);

CREATE TABLE consumer_runs (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('unavailable', 'listed', 'failed')),
  detail TEXT NOT NULL DEFAULT '' CHECK(length(detail) <= 500),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id)
);
