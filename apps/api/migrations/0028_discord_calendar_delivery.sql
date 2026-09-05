-- Give tracked Discord scheduled events the same durable, retry-safe lifecycle as Google Calendar.
CREATE TABLE discord_calendar_event_mappings (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  event_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  synced_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, meeting_id),
  UNIQUE (installation_id, event_id)
);

CREATE TABLE discord_calendar_operations (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, meeting_id, generation, action),
  CHECK (action = 'upsert' OR event_id IS NOT NULL)
);

CREATE INDEX idx_discord_calendar_operations_due
ON discord_calendar_operations (installation_id, status, next_attempt_at, updated_at);
