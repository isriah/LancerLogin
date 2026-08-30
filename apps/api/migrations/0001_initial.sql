-- LancerLogin initial schema. Never stores biometric templates or raw scans.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('google', 'local', 'both')),
  telemetry_accepted_at TEXT,
  telemetry_install_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS organization_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  organization_name TEXT NOT NULL DEFAULT 'LancerLogin',
  subtitle TEXT,
  logo_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '#7c3aed',
  secondary_color TEXT NOT NULL DEFAULT '#0f766e',
  appearance TEXT NOT NULL DEFAULT 'system' CHECK (appearance IN ('system', 'light', 'dark')),
  time_zone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  email TEXT,
  local_username TEXT,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(installation_id, email),
  UNIQUE(installation_id, local_username),
  CHECK (email IS NOT NULL OR local_username IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  discord_user_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(installation_id, external_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_events (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  meeting_id TEXT REFERENCES meetings(id),
  source TEXT NOT NULL CHECK (source IN ('kiosk', 'manual')),
  occurred_at TEXT NOT NULL,
  kiosk_event_id TEXT UNIQUE,
  created_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('present', 'absent', 'excused')),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_progress (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  completed_by TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (installation_id, step)
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kiosks (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  pairing_code_id TEXT NOT NULL UNIQUE REFERENCES pairing_codes(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS encrypted_integrations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'resend', 'discord')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(installation_id, provider)
);

CREATE TABLE IF NOT EXISTS integration_deliveries (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'discord')),
  delivery_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(installation_id, provider, delivery_key)
);

CREATE TABLE IF NOT EXISTS integration_state (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('discord')),
  state_key TEXT NOT NULL,
  external_id TEXT,
  content_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, provider, state_key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_member_meeting ON attendance_events(member_id, meeting_id);
CREATE INDEX IF NOT EXISTS idx_meetings_installation_starts ON meetings(installation_id, starts_at);
