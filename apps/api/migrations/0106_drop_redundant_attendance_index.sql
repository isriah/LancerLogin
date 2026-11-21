-- idx_attendance_member_meeting(member_id, meeting_id) is the first two columns of
-- idx_events_member_meeting_action_time(member_id, meeting_id, action, occurred_at), added by 0037. Both are plain
-- indexes: not unique, not partial, default collation and order, so the wider one serves every lookup by member or by
-- member and meeting, including the foreign key check when a member is deleted. D1 counts each index entry as a row
-- written, so a scan now costs one row fewer. tests-ts/attendance-event-plans.test.ts pins the query plans.
-- A Worker from before this migration names neither index.
DROP INDEX IF EXISTS idx_attendance_member_meeting;
