-- Add the explicit themed appearance and retain operational kiosk health.
CREATE TABLE organization_settings_next (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  organization_name TEXT NOT NULL DEFAULT 'LancerLogin',
  subtitle TEXT,
  logo_data TEXT,
  primary_color TEXT NOT NULL DEFAULT '#7c3aed',
  secondary_color TEXT NOT NULL DEFAULT '#0f766e',
  appearance TEXT NOT NULL DEFAULT 'system' CHECK (appearance IN ('system', 'themed', 'light', 'dark')),
  time_zone TEXT NOT NULL
);

INSERT INTO organization_settings_next (
  installation_id,
  organization_name,
  subtitle,
  logo_data,
  primary_color,
  secondary_color,
  appearance,
  time_zone
)
SELECT
  installation_id,
  organization_name,
  subtitle,
  logo_data,
  primary_color,
  secondary_color,
  appearance,
  time_zone
FROM organization_settings;

DROP TABLE organization_settings;
ALTER TABLE organization_settings_next RENAME TO organization_settings;

ALTER TABLE kiosks ADD COLUMN reader_online INTEGER CHECK (reader_online IN (0, 1));
ALTER TABLE kiosks ADD COLUMN release_version TEXT;
