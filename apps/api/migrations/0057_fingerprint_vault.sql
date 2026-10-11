-- Optional server-decryptable biometric storage. This is operational authority,
-- not portable backup content. The encryption key belongs in Worker secrets.
CREATE TABLE kiosk_fingerprint_vault_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL UNIQUE CHECK(length(vault_id)=64),
  key_id TEXT NOT NULL CHECK(length(key_id)=64),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE kiosk_fingerprint_vault_templates (
  fingerprint_id TEXT PRIMARY KEY CHECK(length(fingerprint_id)=64),
  installation_id TEXT NOT NULL REFERENCES kiosk_fingerprint_vault_settings(installation_id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  template_digest TEXT NOT NULL CHECK(length(template_digest)=64),
  ciphertext TEXT NOT NULL CHECK(length(ciphertext)=2072),
  nonce TEXT NOT NULL CHECK(length(nonce)=16),
  format TEXT NOT NULL CHECK(format='r503-model-1536'),
  source_kiosk_id TEXT NOT NULL,
  source_pairing_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL CHECK(length(enrollment_id) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL,
  UNIQUE(installation_id,vault_id,template_digest)
);
CREATE INDEX idx_fingerprint_vault_member ON kiosk_fingerprint_vault_templates(installation_id,member_id);

-- Revoking the source kiosk cannot remove a valid installation enrollment.
-- Upload authority is checked at insertion; reads use the receiving kiosk's
-- current authority rather than the continued existence of the original source.
CREATE TRIGGER fingerprint_vault_insert_authority BEFORE INSERT ON kiosk_fingerprint_vault_templates
WHEN NOT EXISTS (
  SELECT 1 FROM kiosk_fingerprint_vault_settings v
  JOIN platform_modules p ON p.installation_id=v.installation_id AND p.module_id='attendance' AND p.phase='enabled'
  JOIN kiosks k ON k.installation_id=v.installation_id AND k.id=NEW.source_kiosk_id AND k.active=1 AND k.pairing_bound=1
  JOIN members m ON m.installation_id=v.installation_id AND m.id=NEW.member_id AND m.active=1
  WHERE v.installation_id=NEW.installation_id AND v.vault_id=NEW.vault_id AND v.enabled=1
    AND k.pairing_code_id=NEW.source_pairing_id
) OR (SELECT count(*) FROM kiosk_fingerprint_vault_templates WHERE installation_id=NEW.installation_id)>=20000
  OR (SELECT count(*) FROM kiosk_fingerprint_vault_templates WHERE installation_id=NEW.installation_id AND member_id=NEW.member_id)>=20
BEGIN SELECT RAISE(ABORT,'fingerprint vault authority or capacity unavailable'); END;

CREATE TRIGGER fingerprint_vault_template_immutable BEFORE UPDATE ON kiosk_fingerprint_vault_templates
BEGIN SELECT RAISE(ABORT,'fingerprint vault templates are immutable'); END;

CREATE TRIGGER fingerprint_vault_disabled AFTER UPDATE OF enabled,vault_id,key_id ON kiosk_fingerprint_vault_settings
WHEN NEW.enabled=0 OR NEW.vault_id IS NOT OLD.vault_id OR NEW.key_id IS NOT OLD.key_id
BEGIN DELETE FROM kiosk_fingerprint_vault_templates WHERE installation_id=OLD.installation_id; END;

CREATE TRIGGER fingerprint_vault_member_revoked AFTER UPDATE OF active,external_id ON members
WHEN NEW.active=0 OR NEW.external_id IS NOT OLD.external_id
BEGIN DELETE FROM kiosk_fingerprint_vault_templates WHERE member_id=OLD.id; END;

CREATE TRIGGER fingerprint_vault_module_revoked AFTER UPDATE OF phase,generation ON platform_modules
WHEN NEW.module_id='attendance' AND (NEW.phase<>'enabled' OR NEW.generation<>OLD.generation)
BEGIN UPDATE kiosk_fingerprint_vault_settings SET enabled=0 WHERE installation_id=NEW.installation_id; END;

CREATE TRIGGER fingerprint_vault_module_deleted AFTER DELETE ON platform_modules
WHEN OLD.module_id='attendance'
BEGIN DELETE FROM kiosk_fingerprint_vault_settings WHERE installation_id=OLD.installation_id; END;
