-- Fingerprint scan integrity. One member cannot scan on two kiosks seconds apart, so a kiosk scan that matches a member
-- whose accepted scan on a different kiosk is within 30 seconds of it is refused and the kiosk asks for a rescan.
-- Members whose recent match scores are weak are suggested for re-enrollment, which an Admin can dismiss.
-- Diagnostic data: it is not part of backups, and Delete installation removes it.
-- Additive: the previously deployed Worker never reads or writes these tables.

-- Which kiosk recorded each accepted kiosk scan, so a scan on another kiosk can be compared with it by occurred_at.
CREATE TABLE kiosk_accepted_scans (
  installation_id TEXT NOT NULL,
  kiosk_event_id TEXT NOT NULL,
  kiosk_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, kiosk_event_id)
);
CREATE INDEX kiosk_accepted_scans_member ON kiosk_accepted_scans(installation_id, member_id, occurred_at);
CREATE INDEX kiosk_accepted_scans_recorded ON kiosk_accepted_scans(installation_id, recorded_at);

-- Scans refused as a possible wrong match, with the accepted scan on the other kiosk they conflicted with.
CREATE TABLE kiosk_possible_wrong_matches (
  installation_id TEXT NOT NULL,
  kiosk_event_id TEXT NOT NULL,
  kiosk_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  match_score INTEGER CHECK(match_score BETWEEN 0 AND 65535),
  other_kiosk_event_id TEXT NOT NULL,
  other_kiosk_id TEXT NOT NULL,
  other_occurred_at TEXT NOT NULL,
  other_match_score INTEGER CHECK(other_match_score BETWEEN 0 AND 65535),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, kiosk_event_id)
);
CREATE INDEX kiosk_possible_wrong_matches_recorded ON kiosk_possible_wrong_matches(installation_id, recorded_at);

-- When a member last re-enrolled from the dashboard, and when an Admin last dismissed their re-enrollment suggestion.
-- Only scans after the later of the two count toward the member's median match score.
CREATE TABLE kiosk_fingerprint_reenrollment (
  installation_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  reenrolled_at TEXT,
  dismissed_at TEXT,
  dismissed_by TEXT,
  PRIMARY KEY(installation_id, member_id)
);
