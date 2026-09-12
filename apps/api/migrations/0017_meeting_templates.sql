-- Reusable scheduling defaults. Templates never create attendance records themselves.
CREATE TABLE meeting_templates (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  notes TEXT,
  recurrence_frequency TEXT CHECK (recurrence_frequency IN ('daily', 'weekly', 'biweekly', 'monthly')),
  recurrence_duration_days INTEGER CHECK (recurrence_duration_days IS NULL OR recurrence_duration_days BETWEEN 1 AND 3650),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, name)
);

CREATE INDEX idx_meeting_templates_installation_name
ON meeting_templates (installation_id, name);
