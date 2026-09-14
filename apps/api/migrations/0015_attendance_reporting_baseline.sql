-- Keep historical attendance while allowing an explicit operational reporting period.
ALTER TABLE organization_settings ADD COLUMN attendance_reporting_starts_on TEXT;

CREATE INDEX idx_meetings_installation_reporting_period
ON meetings (installation_id, starts_at)
WHERE deleted_at IS NULL;
