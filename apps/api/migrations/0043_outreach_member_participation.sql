CREATE TABLE hours_reopen_windows (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  activity_id TEXT,
  starts_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id),
  CHECK(typeof(starts_ms)='integer' AND typeof(expires_ms)='integer' AND expires_ms>starts_ms AND expires_ms-starts_ms<=604800000)
);
CREATE INDEX hours_reopen_active ON hours_reopen_windows(installation_id,revoked,expires_ms,activity_id);

CREATE TABLE hours_correction_requests (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('public','discord')),
  attribution TEXT NOT NULL CHECK((channel='public' AND attribution='self_asserted') OR (channel='discord' AND attribution='linked_discord')),
  requester_member_id TEXT NOT NULL REFERENCES members(id),
  entry_id TEXT,
  claimed_service_date TEXT,
  message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
  key_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision IN (0,1)),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY(installation_id,id),
  UNIQUE(installation_id,channel,key_hash),
  FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id),
  CHECK(claimed_service_date IS NULL OR claimed_service_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK((status='open' AND revision=0 AND resolved_at IS NULL) OR (status='resolved' AND revision=1 AND resolved_at IS NOT NULL))
);
CREATE INDEX hours_correction_inbox ON hours_correction_requests(installation_id,status,id);
CREATE INDEX hours_correction_member ON hours_correction_requests(installation_id,requester_member_id,id);

CREATE TABLE hours_correction_resolutions (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('acknowledged','dismissed','corrected','voided')),
  note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 4000),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  entry_id TEXT,
  entry_revision INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,request_id),
  FOREIGN KEY(installation_id,request_id) REFERENCES hours_correction_requests(installation_id,id),
  FOREIGN KEY(installation_id,entry_id,entry_revision) REFERENCES hours_entry_revisions(installation_id,entry_id,revision),
  CHECK((entry_id IS NULL AND entry_revision IS NULL) OR (entry_id IS NOT NULL AND entry_revision>=0)),
  CHECK(action NOT IN ('corrected','voided') OR entry_id IS NOT NULL)
);

CREATE TRIGGER hours_reopen_window_immutable BEFORE UPDATE ON hours_reopen_windows
WHEN OLD.revoked=1 OR NEW.revoked!=1 OR NEW.revision!=OLD.revision+1
  OR NEW.installation_id IS NOT OLD.installation_id OR NEW.id IS NOT OLD.id OR NEW.activity_id IS NOT OLD.activity_id
  OR NEW.starts_ms!=OLD.starts_ms OR NEW.expires_ms!=OLD.expires_ms OR NEW.reason!=OLD.reason
  OR NEW.actor_user_id!=OLD.actor_user_id OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'hours_reopen_window_immutable'); END;

CREATE TRIGGER hours_correction_request_immutable BEFORE UPDATE ON hours_correction_requests
WHEN OLD.status!='open' OR NEW.status!='resolved' OR NEW.revision!=1 OR NEW.resolved_at IS NULL
  OR NEW.installation_id IS NOT OLD.installation_id OR NEW.id IS NOT OLD.id OR NEW.channel IS NOT OLD.channel
  OR NEW.attribution IS NOT OLD.attribution OR NEW.requester_member_id IS NOT OLD.requester_member_id
  OR NEW.entry_id IS NOT OLD.entry_id OR NEW.claimed_service_date IS NOT OLD.claimed_service_date
  OR NEW.message IS NOT OLD.message OR NEW.key_hash IS NOT OLD.key_hash OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'hours_correction_request_immutable'); END;

CREATE TRIGGER hours_correction_resolution_immutable BEFORE UPDATE ON hours_correction_resolutions
BEGIN SELECT RAISE(ABORT,'hours_correction_resolution_immutable'); END;
