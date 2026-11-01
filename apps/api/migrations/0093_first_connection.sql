-- Core's shared FIRST data connection (services.first). An Admin's FRC and FTC Events API credentials, each program's
-- current season, FIRST's answers for team numbers, and the requests sent to FIRST in the last minute.
-- Additive: the previously deployed Worker never reads these tables. Only first_credentials is backed up; the other
-- tables are caches and limits that a restore leaves empty.

-- One FIRST Events API credential per program. The token is encrypted with Core's integration key; only its ciphertext
-- and IV are stored. checked_at is when FIRST last accepted the credential. key_version counts saves, as for
-- google_calendar_authorizations.
CREATE TABLE first_credentials (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  program TEXT NOT NULL CHECK (program IN ('FRC', 'FTC')),
  username TEXT NOT NULL CHECK (length(username) BETWEEN 1 AND 100),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 4000),
  iv TEXT NOT NULL CHECK (length(iv) BETWEEN 1 AND 200),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(key_version) = 'integer' AND key_version >= 1),
  checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, program)
);

-- Each Events API program's current season as its API root reported it, asked again after a day.
CREATE TABLE first_seasons (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  program TEXT NOT NULL CHECK (program IN ('FRC', 'FTC')),
  season INTEGER NOT NULL CHECK (typeof(season) = 'integer' AND season BETWEEN 2000 AND 2999),
  checked_ms INTEGER NOT NULL CHECK (typeof(checked_ms) = 'integer'),
  PRIMARY KEY (installation_id, program)
);

-- FIRST's answer for one team number in one program: a team for seven days, "no such team" (NULL name) for one day.
CREATE TABLE first_team_cache (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  program TEXT NOT NULL CHECK (program IN ('FRC', 'FTC', 'Challenge', 'Explore')),
  number TEXT NOT NULL CHECK (length(number) BETWEEN 1 AND 6 AND number NOT GLOB '*[^0-9]*' AND number NOT GLOB '0*'),
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 100),
  location TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 200),
  season INTEGER CHECK (season IS NULL OR (typeof(season) = 'integer' AND season BETWEEN 2000 AND 2999)),
  source TEXT NOT NULL CHECK (source IN ('events-api', 'first-search')),
  checked_ms INTEGER NOT NULL CHECK (typeof(checked_ms) = 'integer'),
  PRIMARY KEY (installation_id, program, number),
  CHECK (name IS NOT NULL OR (location = '' AND season IS NULL))
);
CREATE INDEX first_team_cache_checked ON first_team_cache(installation_id, checked_ms);

-- Requests sent to FIRST and guest lookups, kept for a minute, per bucket: one per provider for the installation limit
-- and one per hashed visitor address for the per-visitor limit.
CREATE TABLE first_requests (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK (length(bucket) BETWEEN 1 AND 100),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  requested_ms INTEGER NOT NULL CHECK (typeof(requested_ms) = 'integer'),
  PRIMARY KEY (installation_id, id)
);
CREATE INDEX first_requests_bucket_time ON first_requests(installation_id, bucket, requested_ms);
