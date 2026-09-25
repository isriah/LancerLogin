-- Percentage policies may either exclude excused meetings or count them as missed.
ALTER TABLE label_attendance_rules ADD COLUMN excused_handling TEXT NOT NULL DEFAULT 'exclude'
  CHECK (excused_handling IN ('exclude', 'count_missed'));
