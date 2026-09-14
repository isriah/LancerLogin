-- Configure member attendance anomaly insights without changing attendance outcomes.
ALTER TABLE organization_settings
ADD COLUMN anomaly_late_threshold_minutes INTEGER NOT NULL DEFAULT 10
CHECK (anomaly_late_threshold_minutes BETWEEN 0 AND 1440);

ALTER TABLE organization_settings
ADD COLUMN anomaly_early_threshold_minutes INTEGER NOT NULL DEFAULT 10
CHECK (anomaly_early_threshold_minutes BETWEEN 0 AND 1440);
