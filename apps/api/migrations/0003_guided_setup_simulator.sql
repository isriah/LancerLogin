-- Isolate software-only setup checks from production kiosk state and attendance.
ALTER TABLE meetings ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));
ALTER TABLE pairing_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'hardware' CHECK (purpose IN ('hardware', 'simulator'));

CREATE TABLE IF NOT EXISTS simulated_kiosk_sessions (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  pairing_code_id TEXT NOT NULL UNIQUE REFERENCES pairing_codes(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  online INTEGER NOT NULL DEFAULT 1 CHECK (online IN (0, 1)),
  last_seen_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
