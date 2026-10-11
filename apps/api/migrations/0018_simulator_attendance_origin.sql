-- Browser emulator attendance remains distinguishable from physical and manual events.
PRAGMA foreign_keys = OFF;
CREATE TABLE attendance_events_simulator_origin (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id), meeting_id TEXT REFERENCES meetings(id),
  source TEXT NOT NULL CHECK (source IN ('kiosk', 'manual', 'simulator')),
  occurred_at TEXT NOT NULL, kiosk_event_id TEXT UNIQUE, created_by TEXT REFERENCES users(id),
  action TEXT NOT NULL DEFAULT 'check_in' CHECK (action IN ('check_in', 'check_out'))
);
INSERT INTO attendance_events_simulator_origin (id, installation_id, member_id, meeting_id, source, occurred_at, kiosk_event_id, created_by, action)
SELECT id, installation_id, member_id, meeting_id, source, occurred_at, kiosk_event_id, created_by, action FROM attendance_events;
DROP TABLE attendance_events;
ALTER TABLE attendance_events_simulator_origin RENAME TO attendance_events;
CREATE INDEX IF NOT EXISTS idx_attendance_member_meeting ON attendance_events(member_id, meeting_id);
PRAGMA foreign_keys = ON;
