-- Progress and completion marker of the one-time correction of stored participation start dates
-- (apps/api/src/participation-start-correction.ts).
--
-- members.attendance_required_from was written automatically as the UTC date of the member's created_at by migration
-- 0019, by roster imports and member edits until 2026-09-28, and by restores of backups older than the column. The
-- organization-local date of that instant can be a day earlier or later, and SQLite cannot convert IANA time zones, so
-- the Worker's scheduled housekeeping corrects those rows a small batch at a time and records where it is here:
-- - run_id: one run of the job. A restore that replaces members starts a new run, and every write of a pass checks the
--   run it read, so a pass that began before the restore changes nothing after it;
-- - cursor: the last members.id examined;
-- - changes_json and left_alone_json: what the job changed (member, old date, new date, meetings that started or stopped
--   counting) and what it left alone because an Admin's change of the start date is on record. The same lists are
--   written to one audit_log entry (audit_id) in the batch that changes the rows, and that entry is what a reversal reads;
-- - worsened and no_effect: how many members it left alone because the correction would have added a missed meeting or
--   removed a presence, or would have changed nothing;
-- - completed_at: set once every member was examined. The job then never looks at members again.
--
-- The row is never part of a backup. A roster or entire-installation restore replaces it with a new run in its own
-- transaction (the cascade from installations removes the old one first). The job then runs again over the restored
-- members, and changes nothing the first run already corrected.
-- Additive: the previously deployed Worker never reads this table.
CREATE TABLE participation_start_correction (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  examined INTEGER NOT NULL DEFAULT 0 CHECK (examined >= 0),
  changes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changes_json)),
  left_alone_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(left_alone_json)),
  worsened INTEGER NOT NULL DEFAULT 0 CHECK (worsened >= 0),
  no_effect INTEGER NOT NULL DEFAULT 0 CHECK (no_effect >= 0),
  audit_id TEXT,
  started_at TEXT,
  completed_at TEXT
);
