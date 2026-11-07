-- Meeting CSV import can add meetings that have already ended. They count toward attendance, but no Discord absence notice
-- is ever posted for them: the import records a `skipped` notification row, and the notice job only posts for meetings with
-- no row (or a failed one). `skipped` joins the constrained status list, so the table is rebuilt with its history kept. Unlike
-- 0085, the rebuild copies rows through a scratch table instead of renaming: in D1, ALTER TABLE ... RENAME rechecks every
-- trigger in the schema and fails on the kiosk roster revision triggers from 0082 and 0091.
-- Forward compatible: the previously deployed Worker reads and writes the same columns, never writes `skipped`, and treats
-- any existing row other than `failed` as already handled.
PRAGMA foreign_keys = OFF;

CREATE TABLE discord_attendance_notifications_before_skipped AS SELECT installation_id, meeting_id, status, message_id, attempts,
  last_error, processed_at, updated_at, channel_id, expires_at, deleted_at, thread_created_at, delivery_id FROM discord_attendance_notifications;

DROP TABLE discord_attendance_notifications;

CREATE TABLE discord_attendance_notifications (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'no_recipients', 'failed', 'skipped')),
  message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  channel_id TEXT,
  expires_at TEXT,
  deleted_at TEXT,
  thread_created_at TEXT,
  delivery_id TEXT,
  PRIMARY KEY (installation_id, meeting_id)
);

INSERT INTO discord_attendance_notifications (installation_id, meeting_id, status, message_id, attempts, last_error, processed_at, updated_at,
  channel_id, expires_at, deleted_at, thread_created_at, delivery_id)
SELECT installation_id, meeting_id, status, message_id, attempts, last_error, processed_at, updated_at,
  channel_id, expires_at, deleted_at, thread_created_at, delivery_id
FROM discord_attendance_notifications_before_skipped;

DROP TABLE discord_attendance_notifications_before_skipped;

CREATE INDEX idx_discord_attendance_notifications_expiry
ON discord_attendance_notifications (installation_id, status, expires_at)
WHERE message_id IS NOT NULL AND deleted_at IS NULL;

PRAGMA foreign_keys = ON;
