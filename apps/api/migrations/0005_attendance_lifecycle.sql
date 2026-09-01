-- Require complete attendance sessions, one organization-wide closing delay, and durable Discord delivery state.
ALTER TABLE organization_settings ADD COLUMN late_scan_minutes INTEGER NOT NULL DEFAULT 30 CHECK (late_scan_minutes BETWEEN 0 AND 180);
ALTER TABLE organization_settings ADD COLUMN logo_backdrop TEXT NOT NULL DEFAULT 'auto' CHECK (logo_backdrop IN ('auto', 'light', 'dark', 'none'));

ALTER TABLE attendance_events ADD COLUMN action TEXT NOT NULL DEFAULT 'check_in' CHECK (action IN ('check_in', 'check_out'));

-- Preserve attendance credit recorded by older releases by closing one legacy session per member and meeting.
INSERT OR IGNORE INTO attendance_events (
  id, installation_id, member_id, meeting_id, source, occurred_at, kiosk_event_id, created_by, action
)
SELECT
  'legacy-checkout:' || member_id || ':' || meeting_id,
  installation_id,
  member_id,
  meeting_id,
  'manual',
  MAX(occurred_at),
  NULL,
  MAX(created_by),
  'check_out'
FROM attendance_events
WHERE meeting_id IS NOT NULL
GROUP BY installation_id, member_id, meeting_id;

CREATE TABLE IF NOT EXISTS discord_attendance_notifications (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'no_recipients', 'failed')),
  message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, meeting_id)
);

CREATE TABLE IF NOT EXISTS discord_attendance_recipients (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, meeting_id, member_id)
);

ALTER TABLE discord_attendance_contests ADD COLUMN submitted_by_discord_user_id TEXT;
ALTER TABLE discord_attendance_contests ADD COLUMN review_note TEXT;
