ALTER TABLE installations ADD COLUMN google_enabled INTEGER NOT NULL DEFAULT 0 CHECK (google_enabled IN (0, 1));
ALTER TABLE installations ADD COLUMN resend_enabled INTEGER NOT NULL DEFAULT 0 CHECK (resend_enabled IN (0, 1));
ALTER TABLE installations ADD COLUMN discord_enabled INTEGER NOT NULL DEFAULT 0 CHECK (discord_enabled IN (0, 1));

UPDATE installations
SET google_enabled = EXISTS (
      SELECT 1 FROM encrypted_integrations
      WHERE encrypted_integrations.installation_id = installations.id AND provider = 'google'
    ),
    resend_enabled = EXISTS (
      SELECT 1 FROM encrypted_integrations
      WHERE encrypted_integrations.installation_id = installations.id AND provider = 'resend'
    ),
    discord_enabled = EXISTS (
      SELECT 1 FROM encrypted_integrations
      WHERE encrypted_integrations.installation_id = installations.id AND provider = 'discord'
    );
