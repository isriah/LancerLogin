ALTER TABLE discord_attendance_notifications ADD COLUMN delivery_id TEXT;
ALTER TABLE discord_attendance_recipients ADD COLUMN delivery_id TEXT;

CREATE INDEX idx_discord_attendance_recipients_delivery
ON discord_attendance_recipients (installation_id, meeting_id, delivery_id, member_id);
