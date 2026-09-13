-- Apply only to the independently provisioned updater-state database.
-- Never include this file in application migrations or application backups.
CREATE TABLE updater_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);
