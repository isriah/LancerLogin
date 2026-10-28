-- Fingerprint match confidence. The reader reports a score with every match; kiosks record it with each uploaded scan
-- so Admins can see how confident matches are, and can require a minimum score before a match counts as that member.
-- Diagnostic data: it is not part of backups, and Delete installation removes it.
-- Additive: the previously deployed Worker never reads or writes these tables or columns.
CREATE TABLE kiosk_scan_matches (
  installation_id TEXT NOT NULL,
  kiosk_event_id TEXT NOT NULL,
  kiosk_id TEXT NOT NULL,
  match_score INTEGER NOT NULL CHECK(match_score BETWEEN 0 AND 65535),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, kiosk_event_id)
);
CREATE INDEX kiosk_scan_matches_recorded ON kiosk_scan_matches(installation_id, recorded_at);

-- 0 accepts every match the reader reports, as earlier releases did.
CREATE TABLE kiosk_fingerprint_match_settings (
  installation_id TEXT PRIMARY KEY,
  minimum_score INTEGER NOT NULL DEFAULT 0 CHECK(minimum_score BETWEEN 0 AND 1000),
  updated_at TEXT NOT NULL
);

-- Matches below the minimum that the kiosk asked to rescan since it started. NULL for kiosks that do not report it.
ALTER TABLE kiosks ADD COLUMN weak_matches INTEGER;
