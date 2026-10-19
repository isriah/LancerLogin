-- Preserve the effective server configuration independently of kiosk heartbeats.
ALTER TABLE kiosks ADD COLUMN configured_authentication_method TEXT NOT NULL DEFAULT 'fingerprint'
CHECK(configured_authentication_method IN ('fingerprint', 'rfid', 'nfc', 'member_id', 'qr'));

UPDATE kiosks SET configured_authentication_method = COALESCE(
  (SELECT kiosk_authentication_method FROM organization_settings WHERE organization_settings.installation_id = kiosks.installation_id),
  'fingerprint'
);
