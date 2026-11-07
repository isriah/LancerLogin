-- Each module's own reporting start date (operational baseline) for the report datasets it owns. Attendance keeps
-- organization_settings.attendance_reporting_starts_on; this table holds every other module's, such as Outreach's
-- (hour-tracking). A NULL starts_on means the module has no baseline. revision guards concurrent edits.
-- Additive: the previously deployed Worker never reads this table. Backed up with entire-installation backups (schema 50).
CREATE TABLE module_report_baselines (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK (length(module_id) BETWEEN 1 AND 64 AND module_id <> 'attendance'),
  starts_on TEXT CHECK (starts_on IS NULL OR (length(starts_on) = 10 AND starts_on = date(starts_on))),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, module_id)
);

-- Until now one baseline served every report, so Outreach starts with Attendance's date and reports keep their period.
INSERT INTO module_report_baselines (installation_id, module_id, starts_on, revision, updated_at)
SELECT installation_id, 'hour-tracking', attendance_reporting_starts_on, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM organization_settings
WHERE attendance_reporting_starts_on IS NOT NULL
  AND length(attendance_reporting_starts_on) = 10 AND attendance_reporting_starts_on = date(attendance_reporting_starts_on);
