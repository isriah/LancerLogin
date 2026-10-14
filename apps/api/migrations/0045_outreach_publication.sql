CREATE TABLE hours_activity_publications (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  time_zone TEXT NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),
  start_local TEXT NOT NULL CHECK(start_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_local TEXT NOT NULL CHECK(end_local GLOB '[0-2][0-9]:[0-5][0-9]'),
  start_occurrence TEXT CHECK(start_occurrence IN ('earlier','later')),
  end_occurrence TEXT CHECK(end_occurrence IN ('earlier','later')),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  google_calendar INTEGER NOT NULL DEFAULT 0 CHECK(google_calendar IN (0,1)),
  discord INTEGER NOT NULL DEFAULT 0 CHECK(discord IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,activity_id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) ON DELETE CASCADE,
  CHECK(end_ms>start_ms AND google_calendar+discord>0),
  CHECK((status='draft' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL) OR (status='approved' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE TABLE hours_publication_operations (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  publication_revision INTEGER NOT NULL CHECK(typeof(publication_revision)='integer' AND publication_revision>=0),
  provider TEXT NOT NULL CHECK(provider IN ('google_calendar','discord')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts>=0),
  next_attempt_at TEXT,
  external_id TEXT,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,activity_id,publication_revision,provider),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activity_publications(installation_id,activity_id) ON DELETE CASCADE,
  CHECK((status='processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (status!='processing' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX hours_publication_delivery ON hours_publication_operations(installation_id,status,next_attempt_at,updated_at);

CREATE TRIGGER hours_activity_publication_transition BEFORE UPDATE ON hours_activity_publications
WHEN OLD.status='approved'
  OR NEW.installation_id IS NOT OLD.installation_id OR NEW.activity_id IS NOT OLD.activity_id
  OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.status='draft' AND (NEW.revision!=OLD.revision+1 OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
  OR (NEW.status='approved' AND (NEW.revision!=OLD.revision OR NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_at IS NULL
    OR NEW.time_zone IS NOT OLD.time_zone OR NEW.start_local IS NOT OLD.start_local OR NEW.end_local IS NOT OLD.end_local
    OR NEW.start_occurrence IS NOT OLD.start_occurrence OR NEW.end_occurrence IS NOT OLD.end_occurrence
    OR NEW.start_ms!=OLD.start_ms OR NEW.end_ms!=OLD.end_ms OR NEW.google_calendar!=OLD.google_calendar OR NEW.discord!=OLD.discord))
BEGIN SELECT RAISE(ABORT,'hours_activity_publication_transition'); END;
