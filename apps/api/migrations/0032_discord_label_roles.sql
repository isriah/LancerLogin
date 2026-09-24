-- Installation-scoped Discord role associations and resumable manual sync.
CREATE TABLE discord_label_role_mappings (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, label_id),
  UNIQUE (installation_id, guild_id, role_id)
);

CREATE TABLE discord_label_role_challenges (
  id_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE discord_label_role_previews (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE discord_label_role_jobs (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'partial', 'stale')),
  source_fingerprint TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  lease_token TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_discord_label_role_jobs_due ON discord_label_role_jobs (installation_id, status, next_attempt_at);
CREATE UNIQUE INDEX idx_discord_label_role_one_active_job ON discord_label_role_jobs (installation_id, label_id) WHERE status IN ('pending', 'running');
CREATE TABLE discord_label_role_job_items (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES discord_label_role_jobs(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (installation_id, job_id, discord_user_id)
);
