-- Configurable attendance rules. Existing label and target history remains intact.
DROP TRIGGER IF EXISTS seed_mentor_label;
ALTER TABLE organization_settings ADD COLUMN attendance_recent_days INTEGER NOT NULL DEFAULT 30 CHECK (attendance_recent_days BETWEEN 1 AND 365);
ALTER TABLE organization_settings ADD COLUMN attendance_policy_activated_on TEXT;
CREATE TABLE label_attendance_rules (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  starts_on TEXT,
  ends_on TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('weighted_percentage', 'weekly_count')),
  threshold_percent REAL,
  meetings_per_week INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_on IS NULL OR length(starts_on) = 10),
  CHECK (ends_on IS NULL OR (starts_on IS NOT NULL AND length(ends_on) = 10 AND ends_on >= starts_on)),
  CHECK ((rule_type = 'weighted_percentage' AND threshold_percent > 0 AND threshold_percent <= 100 AND meetings_per_week IS NULL) OR
         (rule_type = 'weekly_count' AND meetings_per_week BETWEEN 1 AND 100 AND threshold_percent IS NULL)),
  UNIQUE (installation_id, label_id, starts_on)
);
CREATE UNIQUE INDEX idx_label_attendance_default ON label_attendance_rules(installation_id, label_id) WHERE starts_on IS NULL;
CREATE INDEX idx_label_attendance_dates ON label_attendance_rules(installation_id, label_id, starts_on, ends_on);
CREATE TRIGGER label_attendance_no_overlap_insert BEFORE INSERT ON label_attendance_rules WHEN NEW.starts_on IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Attendance rule periods cannot overlap') WHERE EXISTS (
    SELECT 1 FROM label_attendance_rules old WHERE old.installation_id = NEW.installation_id AND old.label_id = NEW.label_id
      AND old.starts_on IS NOT NULL AND old.starts_on <= COALESCE(NEW.ends_on, '9999-12-31')
      AND NEW.starts_on <= COALESCE(old.ends_on, '9999-12-31'));
END;
CREATE TRIGGER label_attendance_no_overlap_update BEFORE UPDATE ON label_attendance_rules WHEN NEW.starts_on IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Attendance rule periods cannot overlap') WHERE EXISTS (
    SELECT 1 FROM label_attendance_rules old WHERE old.id != NEW.id AND old.installation_id = NEW.installation_id AND old.label_id = NEW.label_id
      AND old.starts_on IS NOT NULL AND old.starts_on <= COALESCE(NEW.ends_on, '9999-12-31')
      AND NEW.starts_on <= COALESCE(old.ends_on, '9999-12-31'));
END;
INSERT INTO label_attendance_rules (id, installation_id, label_id, starts_on, ends_on, rule_type, meetings_per_week, created_by, created_at, updated_at)
SELECT 'legacy:' || id, installation_id, label_id, starts_on, ends_on, 'weekly_count', meetings_per_week, created_by, created_at, created_at FROM label_weekly_targets;
UPDATE organization_settings SET attendance_policy_activated_on = date('now') WHERE installation_id IN (SELECT installation_id FROM label_attendance_rules UNION SELECT installation_id FROM member_labels WHERE formula_enabled = 1);
