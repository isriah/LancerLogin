-- Updater-state D1 only. Never an application migration or portable backup table.
CREATE TABLE updater_service_nonces (
  installation_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, nonce)
);
CREATE INDEX updater_service_nonces_expiry ON updater_service_nonces(expires_at);
CREATE TABLE updater_availability (
  installation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE updater_admissions (
  installation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  release_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'accepted', 'rejected')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, request_id)
);
