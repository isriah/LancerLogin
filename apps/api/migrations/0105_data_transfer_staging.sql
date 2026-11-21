-- Staging for dashboard backups and restores that take several requests (apps/api/src/data-transfer.ts). Reading or
-- checking a whole multi-season backup in one Worker request costs several times the Workers Free CPU allowance, so the
-- dashboard moves a backup in parts and the rows wait here between requests:
-- - a restore session holds the uploaded parts until one final batch replaces the live rows from them;
-- - a backup session holds one snapshot of every table, copied here in a single batch, while the dashboard downloads it.
-- A part is one row whose payload is a JSON array of rows, each row a JSON array of values in column order. Parts with a
-- negative seq are bookkeeping of the session itself (the restore's backup document, the commit marker).
--
-- A restore session that has committed keeps its answer in result_json, and its commit marker, until it expires: the
-- final request can then be repeated when its answer was lost, and is answered the same without running twice.
--
-- Neither table references installations: an entire-installation restore deletes that row in the same batch that reads
-- the staged parts. Sessions are short-lived; starting another one, finishing, cancelling or the scheduled clean-up
-- removes them, and deleting a session removes its parts. Staging is operational state and never part of a backup.
-- Additive: the previously deployed Worker never reads these tables.
CREATE TABLE data_transfer_sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('restore', 'backup')),
  scope TEXT NOT NULL CHECK (scope IN ('meetings', 'roster', 'installation')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  digest TEXT,
  context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
CREATE INDEX data_transfer_sessions_expiry ON data_transfer_sessions(expires_at);

CREATE TABLE data_transfer_chunks (
  session_id TEXT NOT NULL REFERENCES data_transfer_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  digest TEXT,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused >= 0),
  payload TEXT,
  PRIMARY KEY (session_id, seq)
);
