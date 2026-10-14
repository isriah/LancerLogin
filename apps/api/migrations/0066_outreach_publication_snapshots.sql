ALTER TABLE hours_publication_operations ADD COLUMN event_snapshot_json TEXT CHECK(event_snapshot_json IS NULL OR json_valid(event_snapshot_json));
CREATE INDEX hours_entries_logged_order ON hours_entries(installation_id,created_at DESC,id DESC);
