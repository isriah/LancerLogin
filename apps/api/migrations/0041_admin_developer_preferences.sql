-- Keep developer-only controls scoped to each authenticated Admin account.
CREATE TABLE user_preferences (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  developer_scheduler_enabled INTEGER NOT NULL DEFAULT 0
    CHECK(developer_scheduler_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision) = 'integer' AND revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, user_id)
);
