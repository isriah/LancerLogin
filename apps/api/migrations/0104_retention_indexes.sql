-- Housekeeping now removes finished rows of a few tables nothing else deleted (stale-row-pruning.ts): Discord absence
-- notice recipients, failed and dated email sends, Discord label role sync jobs with their items, previews and
-- challenges, and old kiosk commands. These indexes let each prune find its oldest finished rows by a search rather
-- than a scan of the whole table every five minutes. The job items index also serves the foreign key cascade from a
-- job, which otherwise scanned every job's items for each job removed.
-- Additive: indexes only. The previously deployed Worker's queries and writes work unchanged, and backups and restores
-- copy rows, not indexes, so neither changes.
CREATE INDEX idx_discord_attendance_recipients_delivered ON discord_attendance_recipients (installation_id, delivered_at);
CREATE INDEX idx_integration_deliveries_status ON integration_deliveries (installation_id, status, updated_at);
CREATE INDEX idx_discord_label_role_jobs_completed ON discord_label_role_jobs (installation_id, completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX idx_discord_label_role_jobs_label ON discord_label_role_jobs (installation_id, label_id, created_at);
CREATE INDEX idx_discord_label_role_job_items_job ON discord_label_role_job_items (job_id);
CREATE INDEX idx_discord_label_role_previews_expiry ON discord_label_role_previews (installation_id, expires_at);
CREATE INDEX idx_discord_label_role_challenges_expiry ON discord_label_role_challenges (installation_id, expires_at);
CREATE INDEX idx_kiosk_commands_created ON kiosk_commands (installation_id, created_at);
