-- Deployment control is operational state, never a credential or attendance backup.
-- No foreign-key cascade: an installation restore/delete cannot erase a running lock.
CREATE TABLE web_update_requests (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  release_tag TEXT NOT NULL,
  release_sha TEXT NOT NULL,
  release_notes TEXT NOT NULL,
  previous_version TEXT NOT NULL,
  prepared_by TEXT,
  started_by TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared','dispatching','queued','awaiting_approval','running','verifying','succeeded','failed','recovery_required','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  backup_exported_at TEXT,
  started_at TEXT,
  last_poll_at TEXT,
  run_id TEXT,
  executor_run_id TEXT,
  maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0,1)),
  stage TEXT NOT NULL DEFAULT 'prepared',
  error_code TEXT,
  recovery_json TEXT
);
CREATE UNIQUE INDEX idx_web_update_active ON web_update_requests(installation_id)
  WHERE state NOT IN ('succeeded','failed','expired');
CREATE INDEX idx_web_update_history ON web_update_requests(installation_id, created_at);
CREATE TRIGGER web_update_prepared_audit AFTER INSERT ON web_update_requests WHEN NEW.prepared_by IS NOT NULL
BEGIN
  INSERT INTO audit_log(id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
  VALUES ('web-update-prepared:' || NEW.id, NEW.installation_id, NEW.prepared_by, 'web_update.prepared', 'web_update', NEW.id, '{}', NEW.created_at);
END;
CREATE TRIGGER web_update_started_audit AFTER UPDATE OF started_at ON web_update_requests
WHEN OLD.started_at IS NULL AND NEW.started_at IS NOT NULL AND NEW.started_by IS NOT NULL
BEGIN
  INSERT INTO audit_log(id, installation_id, actor_user_id, action, target_type, target_id, metadata_json, created_at)
  VALUES ('web-update-started:' || NEW.id, NEW.installation_id, NEW.started_by, 'web_update.started', 'web_update', NEW.id, '{}', NEW.started_at);
END;
