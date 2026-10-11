-- `install_latest` was added to the Worker command allow-list after this table
-- shipped. Rebuild the constrained table so existing command history is kept.
PRAGMA foreign_keys = OFF;

ALTER TABLE kiosk_commands RENAME TO kiosk_commands_legacy;

CREATE TABLE kiosk_commands (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL CHECK (command_type IN ('reload_display', 'restart_service', 'reboot', 'reset_network_pin', 'install_latest')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  success INTEGER CHECK (success IN (0, 1)),
  result_message TEXT
);

INSERT INTO kiosk_commands (id, installation_id, kiosk_id, command_type, created_by, created_at, completed_at, success, result_message)
SELECT id, installation_id, kiosk_id, command_type, created_by, created_at, completed_at, success, result_message
FROM kiosk_commands_legacy;

DROP TABLE kiosk_commands_legacy;

CREATE INDEX idx_kiosk_commands_pending
  ON kiosk_commands(kiosk_id, completed_at, created_at);

PRAGMA foreign_keys = ON;
