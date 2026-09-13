CREATE TABLE hours_categories (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 mode TEXT NOT NULL CHECK(mode IN ('event','team','task')),
 impact_default INTEGER NOT NULL DEFAULT 0 CHECK(impact_default IN (0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id), UNIQUE(installation_id,id,mode)
);
CREATE TABLE hours_teams (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, number TEXT NOT NULL DEFAULT '', name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
 organization TEXT NOT NULL DEFAULT '', program TEXT NOT NULL DEFAULT '', historical_descriptors TEXT NOT NULL DEFAULT '',
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(installation_id,id)
);
CREATE TABLE hours_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, category_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('event','team','task')),
 service_date TEXT NOT NULL CHECK(length(service_date)=10), team_id TEXT,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 150), description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
 planning_time_zone TEXT NOT NULL, starts_at TEXT, ends_at TEXT, impact_relevant INTEGER NOT NULL CHECK(impact_relevant IN (0,1)),
 source_meeting_id TEXT, source_snapshot TEXT,
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id),
 CHECK((mode='team' AND team_id IS NOT NULL) OR (mode!='team' AND team_id IS NULL)),
 CHECK((source_meeting_id IS NULL AND source_snapshot IS NULL) OR (mode='event' AND source_meeting_id IS NOT NULL AND source_snapshot IS NOT NULL AND json_valid(source_snapshot))),
 FOREIGN KEY(installation_id,category_id,mode) REFERENCES hours_categories(installation_id,id,mode) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,team_id) REFERENCES hours_teams(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX hours_non_event_identity ON hours_activities(installation_id,category_id,service_date,COALESCE(team_id,'')) WHERE mode!='event';
CREATE INDEX hours_activity_dates ON hours_activities(installation_id,archived,service_date,id);
CREATE TABLE hours_activity_staff (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, activity_id TEXT NOT NULL, user_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,activity_id,user_id),
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hours_activity_teams (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, activity_id TEXT NOT NULL, team_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,activity_id,team_id),
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,team_id) REFERENCES hours_teams(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) SELECT id,'event','Event','event',created_at,created_at FROM installations;
INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) SELECT id,'team-support','Team Support','team',created_at,created_at FROM installations;
INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) SELECT id,'other-service','Other Service','task',created_at,created_at FROM installations;
