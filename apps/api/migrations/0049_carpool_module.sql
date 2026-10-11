-- Standalone Carpool planning module. It may reference Core roster identities,
-- but owns its plans, participants, locations, assignments, imports, and exports.
INSERT INTO platform_module_epochs(installation_id,module_id,generation)
  SELECT id,'carpool',1 FROM installations;
INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete)
  SELECT id,'carpool',1,1,'disabled',1,0 FROM installations;

CREATE TABLE carpool_plans (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 150),
  destination TEXT NOT NULL DEFAULT '' CHECK(length(destination)<=300),
  event_reference TEXT CHECK(event_reference IS NULL OR length(event_reference) BETWEEN 1 AND 200),
  event_title_snapshot TEXT CHECK(event_title_snapshot IS NULL OR length(event_title_snapshot)<=150),
  event_starts_at_snapshot TEXT CHECK(event_starts_at_snapshot IS NULL OR datetime(event_starts_at_snapshot) IS NOT NULL),
  radius_miles REAL NOT NULL DEFAULT 12 CHECK(typeof(radius_miles) IN ('integer','real') AND radius_miles BETWEEN 0.5 AND 250),
  preferred_radius_miles REAL NOT NULL DEFAULT 4 CHECK(typeof(preferred_radius_miles) IN ('integer','real') AND preferred_radius_miles BETWEEN 0.5 AND radius_miles),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=4000),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id)
);
CREATE INDEX carpool_plan_catalog ON carpool_plans(installation_id,archived,updated_at,id);

CREATE TABLE carpool_people (
  installation_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  id TEXT NOT NULL,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 150),
  contact TEXT NOT NULL DEFAULT '' CHECK(length(contact)<=300),
  source_row INTEGER CHECK(source_row IS NULL OR (typeof(source_row)='integer' AND source_row>=1)),
  import_identity TEXT CHECK(import_identity IS NULL OR length(import_identity) BETWEEN 1 AND 500),
  import_snapshot_json TEXT CHECK(import_snapshot_json IS NULL OR (json_valid(import_snapshot_json) AND json_type(import_snapshot_json)='object')),
  outbound_status TEXT NOT NULL CHECK(outbound_status IN ('offer','arranged','needs-ride','transit','unknown')),
  outbound_address TEXT NOT NULL DEFAULT '' CHECK(length(outbound_address)<=500),
  outbound_lat REAL,
  outbound_lon REAL,
  outbound_seats INTEGER CHECK(outbound_seats IS NULL OR (typeof(outbound_seats)='integer' AND outbound_seats BETWEEN 0 AND 99)),
  return_status TEXT NOT NULL CHECK(return_status IN ('offer','arranged','needs-ride','transit','unknown')),
  return_address TEXT NOT NULL DEFAULT '' CHECK(length(return_address)<=500),
  return_lat REAL,
  return_lon REAL,
  return_seats INTEGER CHECK(return_seats IS NULL OR (typeof(return_seats)='integer' AND return_seats BETWEEN 0 AND 99)),
  return_same_as_outbound INTEGER NOT NULL DEFAULT 1 CHECK(return_same_as_outbound IN (0,1)),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=4000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,plan_id,id),
  FOREIGN KEY(installation_id,plan_id) REFERENCES carpool_plans(installation_id,id) ON DELETE CASCADE,
  CHECK((outbound_lat IS NULL)=(outbound_lon IS NULL)),
  CHECK((return_lat IS NULL)=(return_lon IS NULL)),
  CHECK(outbound_lat IS NULL OR (outbound_lat BETWEEN -90 AND 90 AND outbound_lon BETWEEN -180 AND 180)),
  CHECK(return_lat IS NULL OR (return_lat BETWEEN -90 AND 90 AND return_lon BETWEEN -180 AND 180)),
  CHECK(outbound_status='offer' OR outbound_seats IS NULL),
  CHECK(return_status='offer' OR return_seats IS NULL)
);
CREATE INDEX carpool_people_plan ON carpool_people(installation_id,plan_id,display_name,id);
CREATE INDEX carpool_people_member ON carpool_people(installation_id,member_id,plan_id);
CREATE UNIQUE INDEX carpool_people_import_identity ON carpool_people(installation_id,plan_id,import_identity) WHERE import_identity IS NOT NULL;

CREATE TABLE carpool_assignments (
  installation_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('outbound','return')),
  rider_id TEXT NOT NULL,
  vehicle_person_id TEXT NOT NULL,
  distance_miles REAL NOT NULL CHECK(typeof(distance_miles) IN ('integer','real') AND distance_miles>=0),
  locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1)),
  manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,plan_id,direction,rider_id),
  FOREIGN KEY(installation_id,plan_id,rider_id) REFERENCES carpool_people(installation_id,plan_id,id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,plan_id,vehicle_person_id) REFERENCES carpool_people(installation_id,plan_id,id) ON DELETE CASCADE,
  CHECK(rider_id<>vehicle_person_id)
);
CREATE INDEX carpool_assignment_vehicle ON carpool_assignments(installation_id,plan_id,direction,vehicle_person_id);

CREATE TABLE carpool_unresolved (
  installation_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('outbound','return')),
  rider_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('needs-review','seat-shortage','no-nearby-car','no-nearby-seat')),
  detail TEXT NOT NULL CHECK(length(detail) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,plan_id,direction,rider_id),
  FOREIGN KEY(installation_id,plan_id,rider_id) REFERENCES carpool_people(installation_id,plan_id,id) ON DELETE CASCADE
);

CREATE TABLE carpool_import_profiles (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  header_key TEXT NOT NULL CHECK(length(header_key) BETWEEN 1 AND 2000),
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json) AND json_type(mapping_json)='object'),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,header_key)
);

CREATE TABLE carpool_location_cache (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 50),
  normalized_address TEXT NOT NULL CHECK(length(normalized_address) BETWEEN 1 AND 500),
  original_address TEXT NOT NULL CHECK(length(original_address) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK(status IN ('success','no-match')),
  latitude REAL,
  longitude REAL,
  label TEXT CHECK(label IS NULL OR length(label)<=500),
  saved_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY(installation_id,cache_key),
  CHECK((latitude IS NULL)=(longitude IS NULL)),
  CHECK((status='success' AND latitude IS NOT NULL) OR (status='no-match' AND latitude IS NULL))
);
CREATE INDEX carpool_location_address ON carpool_location_cache(installation_id,provider,normalized_address);
