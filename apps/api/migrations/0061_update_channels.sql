-- Independent Community-to-Modular bridge. Historical migration bytes stay unchanged.
-- Operational consent is separate from portable application backups, like update locks.
-- Restoring application data must not change an update's selected trust policy.
CREATE TABLE installation_update_settings (
  installation_id TEXT PRIMARY KEY,
  update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable', 'beta')),
  update_channel_revision INTEGER NOT NULL DEFAULT 0 CHECK (update_channel_revision >= 0)
);
INSERT INTO installation_update_settings (installation_id) VALUES ('primary');
ALTER TABLE web_update_requests ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable', 'beta'));
ALTER TABLE kiosk_commands ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable', 'beta'));
ALTER TABLE kiosk_commands ADD COLUMN requested_release_sha TEXT;
ALTER TABLE kiosks ADD COLUMN update_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (update_policy_version IN (1, 2));
