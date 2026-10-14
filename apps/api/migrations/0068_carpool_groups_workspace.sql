-- Carpool-owned group presentation and the most recent complete rebuild snapshot.
ALTER TABLE carpool_plans ADD COLUMN group_settings_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(group_settings_json) AND json_type(group_settings_json)='array' AND length(group_settings_json)<=2000000);
ALTER TABLE carpool_plans ADD COLUMN last_rebuild_json TEXT
  CHECK(last_rebuild_json IS NULL OR (json_valid(last_rebuild_json) AND json_type(last_rebuild_json)='object' AND length(last_rebuild_json)<=6000000));
