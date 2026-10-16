-- Metadata reuse never grants transfer authority. Every poll still validates
-- the current module, pairing, reset state and vault key before reporting this
-- revision, and every template operation retains its own authority checks.
ALTER TABLE kiosk_fingerprint_vault_settings ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK(catalog_revision>=0);

CREATE TRIGGER fingerprint_catalog_insert AFTER INSERT ON kiosk_fingerprint_vault_templates
BEGIN UPDATE kiosk_fingerprint_vault_settings SET catalog_revision=catalog_revision+1 WHERE installation_id=NEW.installation_id; END;

CREATE TRIGGER fingerprint_catalog_delete AFTER DELETE ON kiosk_fingerprint_vault_templates
BEGIN UPDATE kiosk_fingerprint_vault_settings SET catalog_revision=catalog_revision+1 WHERE installation_id=OLD.installation_id; END;

-- Retiring a legacy grant changes the manifest even when its template rows
-- remain stored. Cover all grant mutations, including a reviewed recovery.
CREATE TRIGGER fingerprint_catalog_grant_insert AFTER INSERT ON kiosk_fingerprint_retired_review_grants
BEGIN UPDATE kiosk_fingerprint_vault_settings SET catalog_revision=catalog_revision+1 WHERE installation_id=NEW.installation_id; END;

CREATE TRIGGER fingerprint_catalog_grant_delete AFTER DELETE ON kiosk_fingerprint_retired_review_grants
BEGIN UPDATE kiosk_fingerprint_vault_settings SET catalog_revision=catalog_revision+1 WHERE installation_id=OLD.installation_id; END;

CREATE TRIGGER fingerprint_catalog_grant_update AFTER UPDATE ON kiosk_fingerprint_retired_review_grants
BEGIN UPDATE kiosk_fingerprint_vault_settings SET catalog_revision=catalog_revision+1 WHERE installation_id IN (OLD.installation_id,NEW.installation_id); END;

CREATE TRIGGER fingerprint_catalog_settings_update AFTER UPDATE OF enabled,vault_id,key_id ON kiosk_fingerprint_vault_settings
WHEN NEW.enabled IS NOT OLD.enabled OR NEW.vault_id IS NOT OLD.vault_id OR NEW.key_id IS NOT OLD.key_id
BEGIN UPDATE kiosk_fingerprint_vault_settings SET catalog_revision=catalog_revision+1 WHERE installation_id=NEW.installation_id; END;
