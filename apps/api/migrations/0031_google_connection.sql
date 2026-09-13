-- Central client and organizational grant. Legacy records remain untouched until verified promotion.
CREATE TABLE google_connections (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 shared_mode INTEGER NOT NULL DEFAULT 0 CHECK(shared_mode IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 active_ciphertext TEXT, active_iv TEXT,
 candidate_ciphertext TEXT, candidate_iv TEXT,
 updated_at TEXT NOT NULL,
 grant_proof_id TEXT,
 grant_error TEXT CHECK(grant_error IN ('revoked','temporary')),
 CHECK((active_ciphertext IS NULL) = (active_iv IS NULL)),
 CHECK((candidate_ciphertext IS NULL) = (candidate_iv IS NULL))
);
-- Ephemeral authorization intent is deliberately excluded from portable backups.
CREATE TABLE google_connection_challenges (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 state_hash TEXT NOT NULL, revision INTEGER NOT NULL,
 actor_user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('login-proof','organization')),
 expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 requested_scopes TEXT NOT NULL,
 verifier_ciphertext TEXT NOT NULL, verifier_iv TEXT NOT NULL,
 PRIMARY KEY(installation_id,state_hash),
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) ON DELETE CASCADE
);
-- Ordinary sign-in states have no organizational grant authority.
CREATE TABLE google_login_challenges (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 state_hash TEXT NOT NULL, client_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,state_hash)
);
