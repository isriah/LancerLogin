-- Member PINs for kiosks that require one (web kiosk phase 3). A member types a 4 to 6 digit PIN after confirming their
-- name. The server stores only a salted PBKDF2-SHA256 hash; the PIN itself is never stored.
-- Additive: the previously deployed Worker never reads these tables or columns, and its inserts get the defaults, so every
-- kiosk it pairs or keeps runs without a PIN, as before.
ALTER TABLE kiosks ADD COLUMN require_pin INTEGER NOT NULL DEFAULT 0 CHECK (require_pin IN (0, 1));

-- Lock a member's PIN after repeated wrong tries. Off by default.
ALTER TABLE organization_settings ADD COLUMN pin_lockout_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pin_lockout_enabled IN (0, 1));
ALTER TABLE organization_settings ADD COLUMN pin_lockout_attempts INTEGER NOT NULL DEFAULT 5 CHECK (pin_lockout_attempts BETWEEN 3 AND 20);
ALTER TABLE organization_settings ADD COLUMN pin_lockout_minutes INTEGER NOT NULL DEFAULT 15 CHECK (pin_lockout_minutes BETWEEN 1 AND 1440);

-- One row per member with a PIN. failed_attempts counts wrong tries, online and reported offline, since the last correct
-- PIN, unlock or expired lock.
CREATE TABLE member_pins (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_iterations INTEGER NOT NULL CHECK (pin_iterations BETWEEN 1 AND 100000),
  set_at TEXT NOT NULL,
  set_kiosk_id TEXT REFERENCES kiosks(id) ON DELETE SET NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, member_id)
);

-- A member at a Require PIN kiosk asking an Operator to approve setting their first PIN. A pending request expires 10
-- minutes after it is created; an approval is good for 5 minutes after it is decided (expires_at moves on approval).
-- Short-lived and bound to a kiosk credential, so it is not part of backups.
CREATE TABLE pin_setup_requests (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'used', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX pin_setup_requests_kiosk ON pin_setup_requests(installation_id, kiosk_id, status, expires_at);
CREATE INDEX pin_setup_requests_member ON pin_setup_requests(installation_id, member_id);

-- Require PIN kiosks receive each member's hash and lock in their roster, so a PIN set, reset, lock or unlock changes the
-- kiosk roster revision, as member changes do. A wrong try that only counts does not.
CREATE TRIGGER kiosk_roster_revision_member_pins_insert AFTER INSERT ON member_pins
BEGIN
  UPDATE kiosk_roster_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER kiosk_roster_revision_member_pins_update AFTER UPDATE OF installation_id, member_id, pin_hash, pin_salt, pin_iterations, locked_until ON member_pins
WHEN OLD.installation_id IS NOT NEW.installation_id OR OLD.member_id IS NOT NEW.member_id OR OLD.pin_hash IS NOT NEW.pin_hash OR OLD.pin_salt IS NOT NEW.pin_salt
  OR OLD.pin_iterations IS NOT NEW.pin_iterations OR OLD.locked_until IS NOT NEW.locked_until
BEGIN
  UPDATE kiosk_roster_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER kiosk_roster_revision_member_pins_delete AFTER DELETE ON member_pins
BEGIN
  UPDATE kiosk_roster_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;
