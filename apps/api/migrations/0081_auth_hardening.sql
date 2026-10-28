-- Session revocation. Session tokens carry the epoch they were issued under; bumping it on logout, password reset
-- or deactivation revokes older tokens. Existing tokens have no epoch and count as 0, matching the default.
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0 CHECK(typeof(session_epoch)='integer' AND session_epoch>=0);

-- Throttling for public authentication routes. A bucket is a keyed hash of the route and client address, so no raw
-- address is retained. Rows are independent of installations so first-Admin setup is throttled before one exists.
CREATE TABLE auth_rate_limits (
  bucket TEXT PRIMARY KEY NOT NULL CHECK(length(bucket) BETWEEN 1 AND 128),
  window_start_ms INTEGER NOT NULL CHECK(typeof(window_start_ms)='integer'),
  attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer' AND attempts>=1)
);

-- First-Admin setup codes that already created an installation, stored as a hash of BOOTSTRAP_CODE_HASH. Kept outside
-- installation data so DELETE INSTALLATION cannot reopen setup to anyone who still knows the original code.
CREATE TABLE bootstrap_code_claims (
  claim_key TEXT PRIMARY KEY NOT NULL CHECK(length(claim_key) BETWEEN 1 AND 128),
  claimed_at TEXT NOT NULL
);

-- One-time grants issued to the Admin browser that deleted the installation, so that browser can run setup again with
-- the original code. Anyone else needs a rotated setup code.
CREATE TABLE bootstrap_reset_grants (
  grant_key TEXT PRIMARY KEY NOT NULL CHECK(length(grant_key) BETWEEN 1 AND 128),
  expires_at TEXT NOT NULL
);
