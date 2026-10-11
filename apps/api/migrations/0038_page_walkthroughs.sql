-- Page learning progress belongs to each account, independently of setup.
CREATE TABLE user_walkthroughs (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  content_version INTEGER NOT NULL CHECK (content_version > 0),
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'completed', 'dismissed')),
  step_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, user_id, page_id)
);
