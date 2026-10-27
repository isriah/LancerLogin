-- Synthetic Example plugin schema. Rows link to Core identity by foreign key and never add Core columns.
CREATE TABLE example_items (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  owner_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0, 1)),
  digest_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(digest_count) = 'integer' AND digest_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id)
);
CREATE INDEX example_items_open ON example_items(installation_id, closed, title);

CREATE TABLE example_requests (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 500),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id),
  FOREIGN KEY(installation_id, item_id) REFERENCES example_items(installation_id, id) ON DELETE CASCADE
);
