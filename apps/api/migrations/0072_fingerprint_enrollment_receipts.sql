-- Stable upload identities are separate from mutable reader bytes.
-- Existing templates and delivery history are deliberately not rewritten.
CREATE INDEX idx_fingerprint_vault_source_enrollment ON kiosk_fingerprint_vault_templates(installation_id,vault_id,source_kiosk_id,source_pairing_id,enrollment_id,created_at,fingerprint_id);
CREATE TABLE kiosk_fingerprint_vault_enrollments (
 installation_id TEXT NOT NULL,
 vault_id TEXT NOT NULL,
 source_kiosk_id TEXT NOT NULL,
 source_pairing_id TEXT NOT NULL,
 enrollment_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 fingerprint_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,vault_id,source_kiosk_id,source_pairing_id,enrollment_id)
);
CREATE INDEX idx_fingerprint_vault_receipt_delivery ON kiosk_fingerprint_vault_enrollments(installation_id,vault_id,fingerprint_id,source_kiosk_id,source_pairing_id,member_id,enrollment_id);
CREATE TABLE kiosk_fingerprint_vault_retirements (
 installation_id TEXT NOT NULL,
 vault_id TEXT NOT NULL,
 fingerprint_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 retired_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,vault_id,fingerprint_id)
);
CREATE TRIGGER fingerprint_retirement_revision AFTER INSERT ON kiosk_fingerprint_vault_retirements
BEGIN UPDATE kiosk_fingerprint_vault_settings SET catalog_revision=catalog_revision+1 WHERE installation_id=NEW.installation_id; END;

CREATE TRIGGER fingerprint_enrollment_generation AFTER UPDATE OF enabled,vault_id,key_id ON kiosk_fingerprint_vault_settings
WHEN NEW.enabled=0 OR NEW.vault_id IS NOT OLD.vault_id OR NEW.key_id IS NOT OLD.key_id
BEGIN
 DELETE FROM kiosk_fingerprint_vault_enrollments WHERE installation_id=OLD.installation_id;
 DELETE FROM kiosk_fingerprint_vault_retirements WHERE installation_id=OLD.installation_id;
END;
