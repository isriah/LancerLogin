-- Rejected-scan review moves into the Kiosks page Debug tools. Kiosks keep uploading rejected scans in the background,
-- but those scans no longer make a kiosk degraded or ask an Admin to review them, so every review still open when this
-- ships is dismissed with a fixed note, as kiosk maintenance reviews are. Evidence is kept and stays viewable under
-- Reviewed in Debug tools. Attendance is unchanged, and kiosks clear their local copies on their next review refresh.
-- Data only and forward compatible: the previously deployed Worker reads and writes the same columns and values.
UPDATE kiosk_scan_reviews
SET review_status = 'reviewed',
  reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  review_note = 'Dismissed automatically when rejected-scan review moved to Debug tools'
WHERE review_status = 'open';
