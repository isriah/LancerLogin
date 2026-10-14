-- Preserve fingerprint scanning for existing installations while allowing an Admin
-- to select another local kiosk identity input.
ALTER TABLE organization_settings ADD COLUMN kiosk_authentication_method TEXT NOT NULL DEFAULT 'fingerprint'
CHECK(kiosk_authentication_method IN ('fingerprint', 'rfid', 'nfc', 'member_id', 'qr'));

-- Heartbeats separately report what the physical kiosk has actually applied, so
-- an offline kiosk is never presented as if it already switched methods.
ALTER TABLE kiosks ADD COLUMN authentication_method TEXT NOT NULL DEFAULT 'fingerprint'
CHECK(authentication_method IN ('fingerprint', 'rfid', 'nfc', 'member_id', 'qr'));
