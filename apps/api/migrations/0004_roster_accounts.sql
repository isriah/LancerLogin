-- Optionally link dashboard accounts to roster members without merging authentication and attendance data.
ALTER TABLE users ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_user_per_member
  ON users(installation_id, member_id)
  WHERE member_id IS NOT NULL;
