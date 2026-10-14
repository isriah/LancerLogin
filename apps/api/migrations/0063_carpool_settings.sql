CREATE TABLE carpool_settings (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  radius_miles REAL NOT NULL DEFAULT 12 CHECK(radius_miles BETWEEN 0.5 AND 250),
  preferred_radius_miles REAL NOT NULL DEFAULT 4 CHECK(preferred_radius_miles BETWEEN 0.5 AND radius_miles),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE carpool_geocoding_credentials (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  ciphertext TEXT,
  iv TEXT,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  CHECK((ciphertext IS NULL AND iv IS NULL) OR (ciphertext IS NOT NULL AND iv IS NOT NULL))
);
