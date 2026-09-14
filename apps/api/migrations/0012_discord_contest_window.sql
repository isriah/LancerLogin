ALTER TABLE organization_settings ADD COLUMN discord_contest_window_hours INTEGER NOT NULL DEFAULT 24 CHECK (discord_contest_window_hours BETWEEN 1 AND 168);
