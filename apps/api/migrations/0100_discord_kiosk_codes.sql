-- Discord code mode for kiosks. A member runs /code in the team's Discord server and gets a 6-digit code that works once
-- and expires 2 minutes later; at a kiosk with discord_code on they type the code alone, and the Worker finds the member.
-- discord_code_backup says when such a kiosk also offers its member ID method: only while offline, or always.
-- A new column rather than a new value of member_lookup or configured_authentication_method: those columns have CHECK
-- constraints, and kiosks released before this normalize a value they do not know to another method.
-- Additive: the previously deployed Worker never reads these columns or this table, and its inserts get the defaults, so
-- every kiosk it pairs or keeps runs without Discord codes, as before.
ALTER TABLE kiosks ADD COLUMN discord_code INTEGER NOT NULL DEFAULT 0 CHECK (discord_code IN (0, 1));
ALTER TABLE kiosks ADD COLUMN discord_code_backup TEXT NOT NULL DEFAULT 'offline' CHECK (discord_code_backup IN ('offline', 'always'));

-- The wrong-code throttle, per kiosk. discord_code_failures counts wrong codes in a row since the last correct one; past
-- the free tries each wrong code sets discord_code_throttle_until, and a try before then is refused without looking the
-- code up. Neither column is in backups or in the kiosk roster, and changing them does not bump the kiosk roster revision
-- (no roster trigger watches kiosks).
ALTER TABLE kiosks ADD COLUMN discord_code_failures INTEGER NOT NULL DEFAULT 0 CHECK (discord_code_failures >= 0);
ALTER TABLE kiosks ADD COLUMN discord_code_throttle_until TEXT;

-- One row per member: asking for a new code replaces the old one. Only a SHA-256 hash of the code is stored. Codes last
-- two minutes, so they are not part of backups.
CREATE TABLE discord_kiosk_codes (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, member_id)
);
CREATE INDEX discord_kiosk_codes_hash ON discord_kiosk_codes(installation_id, code_hash);
