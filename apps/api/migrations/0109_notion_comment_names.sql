-- The name Notion shows on the comments Core posts for one module (the comment's display_name), set by an Admin on that
-- module's settings page. A module with no row here posts under its own label, such as "Part Requests"; clearing the
-- name deletes the row. name is stored trimmed, 1 to 100 characters. Removing the Notion connection or a module's
-- chosen databases keeps these rows; deleting a module's data removes its row.
-- Additive: the previously deployed Worker never reads this table. Travels in entire-installation backups (schema 54).
CREATE TABLE notion_comment_names (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK (length(module_id) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND name = trim(name)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, module_id)
);
