ALTER TABLE members ADD COLUMN attendance_required_from TEXT;

CREATE INDEX idx_members_installation_required_from
ON members (installation_id, attendance_required_from);
