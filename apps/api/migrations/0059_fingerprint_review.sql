-- One-time identity review and reset authority. Metadata only, never portable.
CREATE TABLE kiosk_fingerprint_review_requests (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  pairing_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER
);
CREATE UNIQUE INDEX idx_fingerprint_review_request_pending ON kiosk_fingerprint_review_requests(installation_id,kiosk_id,pairing_id) WHERE acknowledged_at IS NULL;
CREATE TABLE kiosk_fingerprint_review_manifests (
  id TEXT PRIMARY KEY CHECK(length(id)=64),
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  pairing_id TEXT NOT NULL,
  vault_id TEXT CHECK(vault_id IS NULL OR length(vault_id)=64),
  module_generation INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  request_id TEXT,
  retained_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(retained_json) AND length(retained_json)<=50000),
  current INTEGER NOT NULL DEFAULT 1 CHECK(current IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE(installation_id,kiosk_id,pairing_id,revision)
);
CREATE UNIQUE INDEX idx_fingerprint_review_current ON kiosk_fingerprint_review_manifests(installation_id,kiosk_id) WHERE current=1;
CREATE TABLE kiosk_fingerprint_review_slots (
  manifest_id TEXT NOT NULL REFERENCES kiosk_fingerprint_review_manifests(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 199),
  original_member_id TEXT NOT NULL CHECK(length(original_member_id) BETWEEN 1 AND 100),
  mapping_digest TEXT NOT NULL CHECK(length(mapping_digest)=64),
  slot_proof TEXT NOT NULL CHECK(length(slot_proof)=64),
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK(status IN ('needs_review','approved','unknown','applied','changed')),
  grant_id TEXT UNIQUE,
  roster_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  approved_member_id TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  applied_at INTEGER,
  PRIMARY KEY(manifest_id,slot)
);
CREATE TABLE kiosk_fingerprint_reset_batches (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE TABLE kiosk_fingerprint_reset_commands (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES kiosk_fingerprint_reset_batches(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  pairing_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE(batch_id,kiosk_id,pairing_id)
);
CREATE INDEX idx_fingerprint_reset_pending ON kiosk_fingerprint_reset_commands(installation_id,kiosk_id,pairing_id,acknowledged_at);

CREATE TRIGGER fingerprint_review_kiosk_revoked AFTER UPDATE OF active,token_hash,pairing_code_id ON kiosks
WHEN NEW.active=0 OR NEW.token_hash IS NOT OLD.token_hash OR NEW.pairing_code_id IS NOT OLD.pairing_code_id
BEGIN DELETE FROM kiosk_fingerprint_review_manifests WHERE kiosk_id=OLD.id; DELETE FROM kiosk_fingerprint_review_requests WHERE kiosk_id=OLD.id; END;
CREATE TRIGGER fingerprint_review_member_revoked AFTER UPDATE OF active,external_id ON members
WHEN NEW.active=0 OR NEW.external_id IS NOT OLD.external_id
BEGIN UPDATE kiosk_fingerprint_review_slots SET status='changed',grant_id=NULL WHERE roster_id=OLD.id; END;
CREATE TRIGGER fingerprint_review_grant_revoked AFTER UPDATE OF status ON kiosk_fingerprint_review_slots
WHEN NEW.status='changed' AND OLD.grant_id IS NOT NULL
BEGIN DELETE FROM kiosk_fingerprint_vault_templates WHERE enrollment_id=OLD.grant_id AND EXISTS(SELECT 1 FROM kiosk_fingerprint_review_manifests h WHERE h.id=OLD.manifest_id AND h.kiosk_id=kiosk_fingerprint_vault_templates.source_kiosk_id AND h.pairing_id=kiosk_fingerprint_vault_templates.source_pairing_id); END;
CREATE TRIGGER fingerprint_review_vault_revoked AFTER UPDATE OF enabled,vault_id,key_id ON kiosk_fingerprint_vault_settings
WHEN NEW.enabled=0 OR NEW.vault_id IS NOT OLD.vault_id OR NEW.key_id IS NOT OLD.key_id
BEGIN DELETE FROM kiosk_fingerprint_review_manifests WHERE installation_id=OLD.installation_id; END;
CREATE TRIGGER fingerprint_review_vault_deleted AFTER DELETE ON kiosk_fingerprint_vault_settings
BEGIN DELETE FROM kiosk_fingerprint_review_manifests WHERE installation_id=OLD.installation_id; END;
CREATE TRIGGER fingerprint_review_module_revoked AFTER UPDATE OF phase,generation ON platform_modules
WHEN NEW.module_id='attendance' AND (NEW.phase<>'enabled' OR NEW.generation<>OLD.generation)
BEGIN DELETE FROM kiosk_fingerprint_review_manifests WHERE installation_id=OLD.installation_id; END;
CREATE TRIGGER fingerprint_review_module_deleted AFTER DELETE ON platform_modules
WHEN OLD.module_id='attendance'
BEGIN DELETE FROM kiosk_fingerprint_review_manifests WHERE installation_id=OLD.installation_id; DELETE FROM kiosk_fingerprint_reset_batches WHERE installation_id=OLD.installation_id; END;

-- A sharing setting cannot bypass a reset that this pairing has not completed.
CREATE TRIGGER fingerprint_vault_reset_pending BEFORE INSERT ON kiosk_fingerprint_vault_templates
WHEN EXISTS(SELECT 1 FROM kiosk_fingerprint_reset_commands r WHERE r.installation_id=NEW.installation_id AND r.kiosk_id=NEW.source_kiosk_id AND r.pairing_id=NEW.source_pairing_id AND r.acknowledged_at IS NULL)
BEGIN SELECT RAISE(ABORT,'fingerprint reset pending'); END;
CREATE TRIGGER fingerprint_key_reset_pending BEFORE INSERT ON kiosk_fingerprint_keys
WHEN EXISTS(SELECT 1 FROM kiosk_fingerprint_reset_commands r WHERE r.installation_id=NEW.installation_id AND r.kiosk_id=NEW.kiosk_id AND r.pairing_id=NEW.pairing_id AND r.acknowledged_at IS NULL)
BEGIN SELECT RAISE(ABORT,'fingerprint reset pending'); END;
CREATE TRIGGER fingerprint_delivery_reset_pending BEFORE INSERT ON kiosk_fingerprint_deliveries
WHEN EXISTS(SELECT 1 FROM kiosk_fingerprint_reset_commands r WHERE r.installation_id=NEW.installation_id AND r.acknowledged_at IS NULL AND ((r.kiosk_id=NEW.sender_id AND r.pairing_id=NEW.sender_pairing_id) OR (r.kiosk_id=NEW.recipient_id AND r.pairing_id=NEW.recipient_pairing_id)))
BEGIN SELECT RAISE(ABORT,'fingerprint reset pending'); END;
