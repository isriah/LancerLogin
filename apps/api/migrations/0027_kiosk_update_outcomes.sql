ALTER TABLE kiosk_commands ADD COLUMN requested_release_version TEXT;
ALTER TABLE kiosk_commands ADD COLUMN release_version_before TEXT;
ALTER TABLE kiosk_commands ADD COLUMN resolution_status TEXT CHECK (resolution_status IN ('succeeded', 'unchanged', 'mismatch'));
ALTER TABLE kiosk_commands ADD COLUMN resolved_release_version TEXT;
ALTER TABLE kiosk_commands ADD COLUMN resolved_at TEXT;
