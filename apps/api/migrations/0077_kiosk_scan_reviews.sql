CREATE TABLE kiosk_scan_reviews (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  received_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'reviewed')),
  reviewed_at TEXT,
  review_note TEXT,
  PRIMARY KEY (installation_id, kiosk_id, event_id)
);
CREATE INDEX kiosk_scan_reviews_status ON kiosk_scan_reviews(installation_id, review_status, received_at, kiosk_id, event_id);
