-- Dashboard users can opt into diagnostic cards that are hidden by default.
ALTER TABLE users ADD COLUMN debug_mode INTEGER NOT NULL DEFAULT 0
  CHECK (debug_mode IN (0, 1));
