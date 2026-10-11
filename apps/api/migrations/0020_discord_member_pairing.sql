CREATE UNIQUE INDEX IF NOT EXISTS idx_members_installation_discord_user
ON members (installation_id, discord_user_id)
WHERE discord_user_id IS NOT NULL;
