-- Dated, overlapping roster labels and meeting audiences.
CREATE TABLE member_labels (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  formula_enabled INTEGER NOT NULL DEFAULT 0 CHECK (formula_enabled IN (0, 1)),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (installation_id, name)
);

CREATE TABLE member_label_changes (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id),
  action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  effective_date TEXT NOT NULL CHECK (length(effective_date) = 10),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (installation_id, member_id, label_id, effective_date)
);
CREATE INDEX idx_member_label_changes_member_date ON member_label_changes(installation_id, member_id, effective_date);

CREATE TABLE label_weekly_targets (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id),
  starts_on TEXT NOT NULL CHECK (length(starts_on) = 10),
  ends_on TEXT NOT NULL CHECK (length(ends_on) = 10 AND ends_on >= starts_on),
  meetings_per_week INTEGER NOT NULL CHECK (meetings_per_week > 0),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_label_weekly_targets_date ON label_weekly_targets(installation_id, label_id, starts_on, ends_on);

ALTER TABLE meetings ADD COLUMN audience_mode TEXT NOT NULL DEFAULT 'all' CHECK (audience_mode IN ('all', 'labels'));
CREATE TABLE meeting_audience_labels (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id),
  PRIMARY KEY (installation_id, meeting_id, label_id)
);

INSERT INTO member_labels (id, installation_id, name, formula_enabled, created_at)
SELECT 'mentor:' || id, id, 'Mentor', 1, created_at FROM installations;

CREATE TRIGGER seed_mentor_label AFTER INSERT ON installations
BEGIN
  INSERT INTO member_labels (id, installation_id, name, formula_enabled, created_at)
  VALUES ('mentor:' || NEW.id, NEW.id, 'Mentor', 1, NEW.created_at);
END;
