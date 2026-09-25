-- Persist reusable personal/shared reports and each user's pinned report tabs.
CREATE TABLE saved_report_views (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'shared')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX saved_report_personal_name
ON saved_report_views(installation_id, owner_user_id, name COLLATE NOCASE)
WHERE scope = 'personal';

CREATE UNIQUE INDEX saved_report_shared_name
ON saved_report_views(installation_id, name COLLATE NOCASE)
WHERE scope = 'shared';

CREATE INDEX saved_report_scope_order
ON saved_report_views(installation_id, scope, created_at, id);

CREATE TABLE saved_report_tabs (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_view_id TEXT NOT NULL REFERENCES saved_report_views(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, user_id, report_view_id),
  UNIQUE (installation_id, user_id, position)
);

CREATE INDEX saved_report_tabs_order
ON saved_report_tabs(installation_id, user_id, position);
