ALTER TABLE encrypted_integrations ADD COLUMN verified_at TEXT;

CREATE TABLE IF NOT EXISTS integration_verification_challenges (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'discord')),
  challenge_hash TEXT NOT NULL,
  target TEXT,
  external_id TEXT,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integration_verification_expiry
  ON integration_verification_challenges(expires_at);
