CREATE TABLE IF NOT EXISTS kiosk_commands (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL CHECK (command_type IN ('reload_display', 'restart_service', 'reboot', 'reset_network_pin')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  success INTEGER CHECK (success IN (0, 1)),
  result_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_kiosk_commands_pending
  ON kiosk_commands(kiosk_id, completed_at, created_at);
