CREATE TABLE hours_public_form_settings (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_validation TEXT NOT NULL DEFAULT 'off' CHECK(member_validation IN ('off','validity','name')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  updated_at TEXT NOT NULL
);
INSERT INTO hours_public_form_settings(installation_id,updated_at)
SELECT id,created_at FROM installations;

-- Lookup throttling retains no member identifiers or network addresses.
CREATE TABLE hours_public_lookup_limits (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL CHECK(typeof(window_start_ms)='integer'),
  attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer' AND attempts BETWEEN 1 AND 60)
);

ALTER TABLE hours_correction_requests ADD COLUMN activity_id TEXT;
CREATE INDEX hours_correction_activity ON hours_correction_requests(installation_id,activity_id,status,id);

CREATE TRIGGER hours_correction_activity_scope BEFORE INSERT ON hours_correction_requests
WHEN NEW.activity_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM hours_activities WHERE installation_id=NEW.installation_id AND id=NEW.activity_id
)
BEGIN SELECT RAISE(ABORT,'hours_correction_activity_scope'); END;

CREATE TRIGGER hours_correction_activity_immutable BEFORE UPDATE ON hours_correction_requests
WHEN NEW.activity_id IS NOT OLD.activity_id
BEGIN SELECT RAISE(ABORT,'hours_correction_activity_immutable'); END;
