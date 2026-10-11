-- Meetings are hidden from scheduling views when deleted, while attendance and audit history remain intact.
ALTER TABLE meetings ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_meetings_active_schedule
ON meetings(installation_id, deleted_at, starts_at);
