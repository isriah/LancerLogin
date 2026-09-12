-- Preserve explicit meeting-weight assignments while allowing Admins to evolve reusable categories.
CREATE TABLE meeting_weight_categories (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 80),
  weight REAL NOT NULL CHECK (weight BETWEEN 0.1 AND 100),
  minimum_duration_minutes INTEGER CHECK (minimum_duration_minutes IS NULL OR minimum_duration_minutes BETWEEN 1 AND 10080),
  position INTEGER NOT NULL CHECK (position >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, name)
);

CREATE INDEX idx_meeting_weight_categories_order
ON meeting_weight_categories (installation_id, active, position, name);

ALTER TABLE meetings ADD COLUMN weight_category_id TEXT REFERENCES meeting_weight_categories(id);
ALTER TABLE meetings ADD COLUMN weight_category_name TEXT;
ALTER TABLE meetings ADD COLUMN attendance_weight REAL NOT NULL DEFAULT 1
CHECK (attendance_weight BETWEEN 0.1 AND 100);
