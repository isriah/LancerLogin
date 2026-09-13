-- Private, expiring interaction state; excluded from portable backup.
-- Interaction webhook tokens are never persisted.
CREATE TABLE discord_documentation_drafts (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 guild_id TEXT NOT NULL,
 discord_user_id TEXT NOT NULL,
 provider_iv TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 expires_at INTEGER NOT NULL,
 confirmation_id TEXT,
 ciphertext TEXT NOT NULL,
 iv TEXT NOT NULL,
 PRIMARY KEY(installation_id,id)
);
CREATE INDEX discord_documentation_draft_expiry ON discord_documentation_drafts(installation_id,expires_at);
CREATE INDEX discord_documentation_draft_actor ON discord_documentation_drafts(installation_id,discord_user_id);
