CREATE TABLE discord_attendance_recipients_next (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, meeting_id, member_id, message_id)
);

INSERT INTO discord_attendance_recipients_next (installation_id, meeting_id, member_id, discord_user_id, message_id, delivered_at)
SELECT installation_id, meeting_id, member_id, discord_user_id, message_id, delivered_at
FROM discord_attendance_recipients;

DROP TABLE discord_attendance_recipients;
ALTER TABLE discord_attendance_recipients_next RENAME TO discord_attendance_recipients;

CREATE INDEX idx_discord_attendance_recipients_message
ON discord_attendance_recipients (installation_id, meeting_id, message_id, discord_user_id);
