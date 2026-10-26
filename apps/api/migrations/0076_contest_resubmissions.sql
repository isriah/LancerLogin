ALTER TABLE organization_settings ADD COLUMN discord_block_recontests_after_rejection INTEGER NOT NULL DEFAULT 0 CHECK (discord_block_recontests_after_rejection IN (0, 1));
ALTER TABLE discord_attendance_contests ADD COLUMN prior_reviews_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(prior_reviews_json) AND json_type(prior_reviews_json) = 'array');
