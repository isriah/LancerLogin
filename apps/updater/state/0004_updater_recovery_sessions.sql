-- Independent updater state only. No application records or personal/IP data.
CREATE TABLE updater_recovery_sessions (
  installation_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, session_hash)
);
CREATE INDEX updater_recovery_sessions_expiry ON updater_recovery_sessions(expires_at);
CREATE TABLE updater_recovery_nonces (
  installation_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, session_hash, nonce)
);
CREATE INDEX updater_recovery_nonces_expiry ON updater_recovery_nonces(expires_at);
CREATE TABLE updater_recovery_login_budget (
  installation_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE TABLE updater_recovery_requests (
  installation_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  failed_job_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'accepted', 'rejected')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, request_id)
);
