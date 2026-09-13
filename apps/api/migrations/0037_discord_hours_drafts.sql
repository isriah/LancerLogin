-- Transient interaction state; deliberately excluded from portable backups.
-- Provider interaction tokens never enter this table.
CREATE TABLE discord_hour_drafts (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 guild_id TEXT NOT NULL, discord_user_id TEXT NOT NULL,
 provider_iv TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('entry','correction')),
 revision INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,
 confirmation_id TEXT,
 ciphertext TEXT NOT NULL, iv TEXT NOT NULL,
 PRIMARY KEY(installation_id,id)
);
CREATE INDEX discord_hour_draft_expiry ON discord_hour_drafts(installation_id,expires_at);
CREATE INDEX discord_hour_draft_actor ON discord_hour_drafts(installation_id,guild_id,discord_user_id);
