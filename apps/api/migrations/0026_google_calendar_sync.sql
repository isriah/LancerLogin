-- Keep optional Google Calendar authorization and retry-safe meeting mappings separate from Google sign-in.
ALTER TABLE installations ADD COLUMN google_calendar_enabled INTEGER NOT NULL DEFAULT 0
CHECK (google_calendar_enabled IN (0, 1));

CREATE TABLE google_calendar_authorizations (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  authorized_at TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE google_calendar_event_mappings (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  synced_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, meeting_id),
  UNIQUE (installation_id, event_id)
);

CREATE TABLE google_calendar_operations (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  starts_at TEXT,
  ends_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, event_id),
  CHECK (action = 'delete' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL))
);

CREATE INDEX idx_google_calendar_operations_due
ON google_calendar_operations (installation_id, status, next_attempt_at, updated_at);
