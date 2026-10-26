CREATE TABLE kiosk_enrollment_sessions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id),
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  pairing_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting_member', 'ready', 'cancelled')),
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  progress TEXT NOT NULL,
  message TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, kiosk_id)
);
