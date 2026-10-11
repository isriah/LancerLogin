-- Final-form Outreach Participation storage for the converged Community baseline.
INSERT INTO platform_module_epochs(installation_id,module_id,generation)
  SELECT id,'hour-tracking',1 FROM installations;
INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete)
  SELECT id,'hour-tracking',1,1,'disabled',1,0 FROM installations;

CREATE TABLE hours_categories (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  mode TEXT NOT NULL CHECK(mode IN ('event','team','task')),
  impact_default INTEGER NOT NULL DEFAULT 1 CHECK(impact_default IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id)
);

CREATE TABLE hours_teams (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '' CHECK(length(number)<=32),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  program TEXT NOT NULL DEFAULT '' CHECK(length(program)<=100),
  historical_descriptors TEXT NOT NULL DEFAULT '' CHECK(length(historical_descriptors)<=4000),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id)
);

CREATE TABLE hours_activities (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('event','team','task')),
  service_date TEXT NOT NULL CHECK(service_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  team_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 150),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=4000),
  location TEXT NOT NULL DEFAULT '' CHECK(length(location)<=300),
  impact_relevant INTEGER NOT NULL DEFAULT 1 CHECK(impact_relevant IN (0,1)),
  source_meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  source_snapshot TEXT CHECK(source_snapshot IS NULL OR json_valid(source_snapshot)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id),
  FOREIGN KEY(installation_id,category_id) REFERENCES hours_categories(installation_id,id),
  FOREIGN KEY(installation_id,team_id) REFERENCES hours_teams(installation_id,id),
  CHECK((mode='team' AND team_id IS NOT NULL) OR (mode!='team' AND team_id IS NULL))
);
CREATE UNIQUE INDEX hours_canonical_activity ON hours_activities(installation_id,category_id,service_date,ifnull(team_id,'')) WHERE mode IN ('team','task');
CREATE INDEX hours_activity_date ON hours_activities(installation_id,service_date,id);

CREATE TABLE hours_entry_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  reporting_days INTEGER NOT NULL DEFAULT 30 CHECK(typeof(reporting_days)='integer' AND reporting_days BETWEEN 1 AND 365),
  reopen_hours INTEGER NOT NULL DEFAULT 24 CHECK(typeof(reopen_hours)='integer' AND reopen_hours BETWEEN 1 AND 168),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991)
);

CREATE TABLE hours_entries (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  activity_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  time_zone TEXT NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),
  start_local TEXT NOT NULL CHECK(start_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_local TEXT NOT NULL CHECK(end_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  start_occurrence TEXT CHECK(start_occurrence IN ('earlier','later')),
  end_occurrence TEXT CHECK(end_occurrence IN ('earlier','later')),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  start_offset_seconds INTEGER NOT NULL,
  end_offset_seconds INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK(typeof(duration_minutes)='integer' AND duration_minutes>0),
  task_notes TEXT NOT NULL DEFAULT '' CHECK(length(task_notes)<=4000),
  status TEXT NOT NULL DEFAULT 'counted' CHECK(status IN ('counted','void')),
  channel TEXT NOT NULL DEFAULT 'staff' CHECK(channel IN ('staff','public','discord')),
  attribution TEXT NOT NULL CHECK(attribution IN ('staff_recorded','self_asserted','linked_discord')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id),
  CHECK(end_ms>start_ms AND (end_ms-start_ms)=duration_minutes*60000),
  CHECK((channel='staff' AND attribution='staff_recorded') OR (channel='public' AND attribution='self_asserted') OR (channel='discord' AND attribution='linked_discord'))
);
CREATE INDEX hours_entries_member_time ON hours_entries(installation_id,member_id,start_ms,end_ms) WHERE status='counted';
CREATE INDEX hours_entries_activity ON hours_entries(installation_id,activity_id,status,id);

CREATE TRIGGER hours_entries_no_overlap_insert BEFORE INSERT ON hours_entries
WHEN NEW.status='counted' AND EXISTS(
  SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.status='counted'
    AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms
)
BEGIN SELECT RAISE(ABORT,'hours_overlap'); END;

CREATE TRIGGER hours_entries_no_overlap_update BEFORE UPDATE OF member_id,start_ms,end_ms,status ON hours_entries
WHEN NEW.status='counted' AND EXISTS(
  SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.status='counted'
    AND e.id!=NEW.id AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms
)
BEGIN SELECT RAISE(ABORT,'hours_overlap'); END;

CREATE TABLE hours_entry_revisions (
  installation_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  activity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('created','corrected','voided')),
  reason TEXT NOT NULL DEFAULT '' CHECK(length(reason)<=4000),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,entry_id,revision),
  FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id)
);

CREATE TABLE hours_submission_keys (
  installation_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('staff','public','discord')),
  key_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,channel,key_hash),
  UNIQUE(installation_id,entry_id),
  FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id) ON DELETE CASCADE
);

INSERT INTO hours_entry_settings(installation_id) SELECT id FROM installations;
INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at)
  SELECT id,'event','Event','event',1,created_at,created_at FROM installations;
INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at)
  SELECT id,'team-support','Team Support','team',1,created_at,created_at FROM installations;
INSERT INTO hours_categories(installation_id,id,name,mode,impact_default,created_at,updated_at)
  SELECT id,'other-service','Other Service','task',1,created_at,created_at FROM installations;
