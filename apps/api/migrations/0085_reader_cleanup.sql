-- Reader cleanup. Retired and replaced fingerprints stay stored on a kiosk's reader after their member link is removed,
-- filling its 200 slots. Kiosks report how many templates the reader stores and how many are linked to members, and an
-- Admin can ask a kiosk to erase the unlinked ones. `erase_unlinked_fingerprints` joins the constrained command list, so
-- the table is rebuilt with its history kept, as 0014 did for `install_latest`.
-- Forward compatible: the previously deployed Worker reads and writes the same columns and never queues the new type.
PRAGMA foreign_keys = OFF;

ALTER TABLE kiosk_commands RENAME TO kiosk_commands_before_reader_cleanup;

CREATE TABLE kiosk_commands (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL CHECK (command_type IN ('reload_display', 'restart_service', 'reboot', 'reset_network_pin', 'install_latest', 'erase_unlinked_fingerprints')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  success INTEGER CHECK (success IN (0, 1)),
  result_message TEXT,
  requested_release_version TEXT,
  release_version_before TEXT,
  resolution_status TEXT CHECK (resolution_status IN ('succeeded', 'unchanged', 'mismatch')),
  resolved_release_version TEXT,
  resolved_at TEXT,
  update_channel TEXT NOT NULL DEFAULT 'stable' CHECK (update_channel IN ('stable', 'beta')),
  requested_release_sha TEXT
);

INSERT INTO kiosk_commands (id, installation_id, kiosk_id, command_type, created_by, created_at, completed_at, success, result_message,
  requested_release_version, release_version_before, resolution_status, resolved_release_version, resolved_at, update_channel, requested_release_sha)
SELECT id, installation_id, kiosk_id, command_type, created_by, created_at, completed_at, success, result_message,
  requested_release_version, release_version_before, resolution_status, resolved_release_version, resolved_at, update_channel, requested_release_sha
FROM kiosk_commands_before_reader_cleanup;

DROP TABLE kiosk_commands_before_reader_cleanup;

CREATE INDEX idx_kiosk_commands_pending
  ON kiosk_commands(kiosk_id, completed_at, created_at);

PRAGMA foreign_keys = ON;

-- NULL for kiosks that do not report reader counts; the erase command is offered only to kiosks that do.
ALTER TABLE kiosks ADD COLUMN reader_templates INTEGER;
ALTER TABLE kiosks ADD COLUMN linked_templates INTEGER;
