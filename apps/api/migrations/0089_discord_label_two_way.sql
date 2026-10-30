-- Two-way sync between a label and its linked Discord role.
-- A mapping syncs Dashboard to Discord (the default, unchanged behavior) or two-way once an Admin confirms a
-- reconciliation. Two-way labels are checked by the scheduled pass: a role added or removed in Discord changes the label,
-- and a label change in the dashboard is pushed to Discord through the existing role sync jobs.
-- Additive: the previously deployed Worker never reads these columns or tables, its inserts get the defaults, and a
-- mapping it creates syncs Dashboard to Discord as before.
ALTER TABLE discord_label_role_mappings ADD COLUMN sync_direction TEXT NOT NULL DEFAULT 'to_discord' CHECK (sync_direction IN ('to_discord', 'two_way'));
ALTER TABLE discord_label_role_mappings ADD COLUMN two_way_enabled_at TEXT;
ALTER TABLE discord_label_role_mappings ADD COLUMN two_way_checked_at TEXT;
ALTER TABLE discord_label_role_mappings ADD COLUMN two_way_error TEXT;
-- Held by one scheduled pass at a time so overlapping passes never apply the same Discord change twice.
ALTER TABLE discord_label_role_mappings ADD COLUMN two_way_lease_expires_at TEXT;

-- Where a dated label change came from. Existing and dashboard changes are 'dashboard'; two-way sync writes 'discord'.
ALTER TABLE member_label_changes ADD COLUMN source TEXT NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'discord'));

-- The last state both sides agreed on, per two-way label and paired member. It tells the scheduled pass which side
-- changed: a label that differs from it changed in the dashboard, a role that differs from it changed in Discord.
CREATE TABLE discord_label_two_way_members (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  synced_state INTEGER NOT NULL CHECK (synced_state IN (0, 1)),
  synced_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, label_id, member_id)
);

-- Discord users holding a two-way label's role who are not linked to any roster member. They are never changed.
CREATE TABLE discord_label_unmatched_role_members (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, label_id, discord_user_id)
);

-- Reviewed mismatch lists for turning on two-way sync. Like role sync previews, each expires, is used once and is
-- refused when the roster, labels or Discord roles changed since it was made.
CREATE TABLE discord_label_two_way_previews (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES member_labels(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
