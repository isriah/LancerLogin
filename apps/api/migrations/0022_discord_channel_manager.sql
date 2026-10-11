ALTER TABLE organization_settings
ADD COLUMN discord_channel_manager_enabled INTEGER NOT NULL DEFAULT 0
CHECK (discord_channel_manager_enabled IN (0, 1));

ALTER TABLE discord_attendance_notifications ADD COLUMN channel_id TEXT;
ALTER TABLE discord_attendance_notifications ADD COLUMN expires_at TEXT;
ALTER TABLE discord_attendance_notifications ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_discord_attendance_notifications_expiry
ON discord_attendance_notifications (installation_id, status, expires_at)
WHERE message_id IS NOT NULL AND deleted_at IS NULL;
