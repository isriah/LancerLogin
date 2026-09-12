-- Separate community telemetry schema. Stores no organization, roster,
-- attendance, biometric, credential, request-header, or raw-IP data.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telemetry_installations (
  install_hash TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_reports (
  install_hash TEXT NOT NULL REFERENCES telemetry_installations(install_hash) ON DELETE CASCADE,
  report_day TEXT NOT NULL,
  release_version TEXT NOT NULL CHECK (length(release_version) BETWEEN 5 AND 40),
  active_kiosk_count INTEGER NOT NULL CHECK (active_kiosk_count IN (0, 1)),
  error_category TEXT CHECK (error_category IN ('worker-internal', 'integration-upstream')),
  metro TEXT CHECK (metro IS NULL OR length(metro) BETWEEN 1 AND 100),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (install_hash, report_day)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_reports_observed ON telemetry_reports(observed_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_reports_release ON telemetry_reports(report_day, release_version);
