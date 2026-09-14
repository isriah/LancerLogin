-- Each roster member becomes accountable for attendance from the date they joined.
-- Preserve existing records; this only establishes the reporting boundary.
UPDATE members
SET attendance_required_from = substr(created_at, 1, 10)
WHERE attendance_required_from IS NULL OR attendance_required_from = '';

CREATE INDEX IF NOT EXISTS idx_members_installation_participation_start
ON members (installation_id, attendance_required_from);
