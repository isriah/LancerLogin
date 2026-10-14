-- Carpool departure times remain independent of related Attendance meetings.
ALTER TABLE carpool_plans ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC'
  CHECK(length(time_zone)>0 AND length(time_zone)<=100);
ALTER TABLE carpool_plans ADD COLUMN outbound_departure_at TEXT;
ALTER TABLE carpool_plans ADD COLUMN return_departure_at TEXT;
