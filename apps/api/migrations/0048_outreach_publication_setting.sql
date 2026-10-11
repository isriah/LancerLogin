ALTER TABLE hours_activities ADD COLUMN event_start_local TEXT CHECK(event_start_local IS NULL OR event_start_local GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE hours_activities ADD COLUMN event_end_local TEXT CHECK(event_end_local IS NULL OR event_end_local GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE hours_activities ADD COLUMN event_start_occurrence TEXT CHECK(event_start_occurrence IS NULL OR event_start_occurrence IN ('earlier','later'));
ALTER TABLE hours_activities ADD COLUMN event_end_occurrence TEXT CHECK(event_end_occurrence IS NULL OR event_end_occurrence IN ('earlier','later'));

CREATE TRIGGER hours_activity_event_schedule_insert BEFORE INSERT ON hours_activities
WHEN (NEW.mode!='event' AND (NEW.event_start_local IS NOT NULL OR NEW.event_end_local IS NOT NULL OR NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
  OR ((NEW.event_start_local IS NULL)!=(NEW.event_end_local IS NULL))
  OR (NEW.event_start_local IS NULL AND (NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'hours_activity_event_schedule'); END;

CREATE TRIGGER hours_activity_event_schedule_update BEFORE UPDATE OF mode,event_start_local,event_end_local,event_start_occurrence,event_end_occurrence ON hours_activities
WHEN (NEW.mode!='event' AND (NEW.event_start_local IS NOT NULL OR NEW.event_end_local IS NOT NULL OR NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
  OR ((NEW.event_start_local IS NULL)!=(NEW.event_end_local IS NULL))
  OR (NEW.event_start_local IS NULL AND (NEW.event_start_occurrence IS NOT NULL OR NEW.event_end_occurrence IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'hours_activity_event_schedule'); END;

CREATE TABLE hours_publication_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO hours_publication_settings(installation_id,automatic,revision,created_at,updated_at)
  SELECT id,0,0,created_at,created_at FROM installations;

ALTER TABLE hours_publication_operations ADD COLUMN action TEXT NOT NULL DEFAULT 'publish' CHECK(action IN ('publish','delete'));

DROP TRIGGER hours_activity_publication_transition;
CREATE TRIGGER hours_activity_publication_transition BEFORE UPDATE ON hours_activity_publications
WHEN NEW.installation_id IS NOT OLD.installation_id OR NEW.activity_id IS NOT OLD.activity_id
  OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status='approved' AND NEW.status!='approved')
  OR (NEW.status='draft' AND (OLD.status!='draft' OR NEW.revision!=OLD.revision+1 OR NEW.reviewed_by_user_id IS NOT NULL OR NEW.reviewed_at IS NOT NULL))
  OR (NEW.status='approved' AND (NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_at IS NULL OR NEW.revision!=OLD.revision+1))
BEGIN SELECT RAISE(ABORT,'hours_activity_publication_transition'); END;
