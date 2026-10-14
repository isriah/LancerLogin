-- Explicit trip scope and provenance for participant location review.
ALTER TABLE carpool_plans ADD COLUMN trip_scope TEXT NOT NULL DEFAULT 'both'
  CHECK(trip_scope IN ('both','outbound','return'));
ALTER TABLE carpool_people ADD COLUMN outbound_location_source TEXT
  CHECK(outbound_location_source IS NULL OR outbound_location_source IN ('lookup','manual','no-match'));
ALTER TABLE carpool_people ADD COLUMN outbound_location_label TEXT
  CHECK(outbound_location_label IS NULL OR length(outbound_location_label)<=500);
ALTER TABLE carpool_people ADD COLUMN return_location_source TEXT
  CHECK(return_location_source IS NULL OR return_location_source IN ('lookup','manual','no-match'));
ALTER TABLE carpool_people ADD COLUMN return_location_label TEXT
  CHECK(return_location_label IS NULL OR length(return_location_label)<=500);
