-- Optional operational relay state. Never portable backup content. Only
-- authenticated encrypted envelopes and public device identities belong here.
CREATE TABLE kiosk_fingerprint_sync (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  sync_id TEXT NOT NULL UNIQUE CHECK(length(sync_id) = 64),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
);

CREATE TABLE kiosk_fingerprint_keys (
  kiosk_id TEXT PRIMARY KEY REFERENCES kiosks(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES kiosk_fingerprint_sync(installation_id) ON DELETE CASCADE,
  pairing_id TEXT NOT NULL,
  key_id TEXT NOT NULL CHECK(length(key_id) = 64),
  public_json TEXT NOT NULL CHECK(json_valid(public_json) AND length(public_json) <= 2048),
  registered_at INTEGER NOT NULL
);

CREATE TABLE kiosk_fingerprint_deliveries (
  transfer_id TEXT PRIMARY KEY CHECK(length(transfer_id) BETWEEN 1 AND 128),
  installation_id TEXT NOT NULL REFERENCES kiosk_fingerprint_sync(installation_id) ON DELETE CASCADE,
  sync_id TEXT NOT NULL,
  sender_id TEXT NOT NULL REFERENCES kiosk_fingerprint_keys(kiosk_id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES kiosk_fingerprint_keys(kiosk_id) ON DELETE CASCADE,
  sender_pairing_id TEXT NOT NULL,
  recipient_pairing_id TEXT NOT NULL,
  sender_key_id TEXT NOT NULL,
  recipient_key_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  envelope_digest TEXT NOT NULL CHECK(length(envelope_digest) = 64),
  envelope_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'complete', 'needs_review', 'rejected')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(sender_id <> recipient_id),
  CHECK(expires_at > created_at AND expires_at <= created_at + 604800000),
  CHECK((status = 'pending' AND envelope_json IS NOT NULL AND json_valid(envelope_json) AND length(envelope_json) <= 8192)
    OR (status <> 'pending' AND envelope_json IS NULL))
);
CREATE INDEX idx_fingerprint_recipient_pending ON kiosk_fingerprint_deliveries(installation_id, recipient_id, status, expires_at);
CREATE INDEX idx_fingerprint_expiry ON kiosk_fingerprint_deliveries(expires_at);

CREATE TRIGGER fingerprint_key_authority BEFORE INSERT ON kiosk_fingerprint_keys
WHEN NOT EXISTS (
  SELECT 1 FROM kiosks k JOIN kiosk_fingerprint_sync s ON s.installation_id=k.installation_id
  WHERE k.id=NEW.kiosk_id AND k.installation_id=NEW.installation_id AND k.pairing_code_id=NEW.pairing_id AND k.active=1 AND s.enabled=1
)
BEGIN SELECT RAISE(ABORT, 'fingerprint key authority unavailable'); END;

CREATE TRIGGER fingerprint_delivery_authority BEFORE INSERT ON kiosk_fingerprint_deliveries
WHEN NOT EXISTS (
  SELECT 1 FROM kiosk_fingerprint_sync s
  JOIN kiosk_fingerprint_keys a ON a.installation_id=s.installation_id AND a.kiosk_id=NEW.sender_id
  JOIN kiosk_fingerprint_keys b ON b.installation_id=s.installation_id AND b.kiosk_id=NEW.recipient_id
  JOIN kiosks ak ON ak.id=a.kiosk_id AND ak.active=1 AND ak.pairing_code_id=a.pairing_id
  JOIN kiosks bk ON bk.id=b.kiosk_id AND bk.active=1 AND bk.pairing_code_id=b.pairing_id
  JOIN members m ON m.installation_id=s.installation_id AND m.id=NEW.member_id AND m.active=1
  WHERE s.installation_id=NEW.installation_id AND s.sync_id=NEW.sync_id AND s.enabled=1
    AND a.pairing_id=NEW.sender_pairing_id AND b.pairing_id=NEW.recipient_pairing_id
    AND a.key_id=NEW.sender_key_id AND b.key_id=NEW.recipient_key_id
) OR (SELECT count(*) FROM kiosk_fingerprint_deliveries WHERE installation_id=NEW.installation_id) >= 2048
BEGIN SELECT RAISE(ABORT, 'fingerprint delivery authority unavailable'); END;

CREATE TRIGGER fingerprint_delivery_identity_immutable BEFORE UPDATE ON kiosk_fingerprint_deliveries
WHEN NEW.transfer_id IS NOT OLD.transfer_id OR NEW.installation_id IS NOT OLD.installation_id OR NEW.sync_id IS NOT OLD.sync_id
  OR NEW.sender_id IS NOT OLD.sender_id OR NEW.recipient_id IS NOT OLD.recipient_id
  OR NEW.sender_pairing_id IS NOT OLD.sender_pairing_id OR NEW.recipient_pairing_id IS NOT OLD.recipient_pairing_id
  OR NEW.sender_key_id IS NOT OLD.sender_key_id OR NEW.recipient_key_id IS NOT OLD.recipient_key_id
  OR NEW.member_id IS NOT OLD.member_id OR NEW.envelope_digest IS NOT OLD.envelope_digest
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (NEW.envelope_json IS NOT NULL AND NEW.envelope_json IS NOT OLD.envelope_json)
  OR (OLD.status <> 'pending' AND NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'fingerprint delivery identity is immutable'); END;

-- A changed registration is explicit delete/re-register, not an in-place key
-- substitution. Deletion cascades every delivery involving that identity.
CREATE TRIGGER fingerprint_key_immutable BEFORE UPDATE ON kiosk_fingerprint_keys
BEGIN SELECT RAISE(ABORT, 'fingerprint key must be revoked before replacement'); END;

CREATE TRIGGER fingerprint_kiosk_revoked AFTER UPDATE OF active,token_hash,pairing_code_id ON kiosks
WHEN NEW.active=0 OR NEW.token_hash IS NOT OLD.token_hash OR NEW.pairing_code_id IS NOT OLD.pairing_code_id
BEGIN DELETE FROM kiosk_fingerprint_keys WHERE kiosk_id=OLD.id; END;

CREATE TRIGGER fingerprint_sync_revoked AFTER UPDATE OF enabled,sync_id ON kiosk_fingerprint_sync
WHEN NEW.enabled=0 OR NEW.sync_id IS NOT OLD.sync_id
BEGIN DELETE FROM kiosk_fingerprint_keys WHERE installation_id=OLD.installation_id; END;

CREATE TRIGGER fingerprint_module_revoked AFTER UPDATE OF phase,generation ON platform_modules
WHEN NEW.module_id='attendance' AND (NEW.phase<>'enabled' OR NEW.generation<>OLD.generation)
BEGIN UPDATE kiosk_fingerprint_sync SET enabled=0 WHERE installation_id=NEW.installation_id; END;

CREATE TRIGGER fingerprint_module_deleted AFTER DELETE ON platform_modules
WHEN OLD.module_id='attendance'
BEGIN DELETE FROM kiosk_fingerprint_sync WHERE installation_id=OLD.installation_id; END;

CREATE TRIGGER fingerprint_member_revoked AFTER UPDATE OF active,external_id ON members
WHEN NEW.active=0 OR NEW.external_id IS NOT OLD.external_id
BEGIN DELETE FROM kiosk_fingerprint_deliveries WHERE member_id=OLD.id; END;
