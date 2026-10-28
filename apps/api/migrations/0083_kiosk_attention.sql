-- Why a kiosk reports a warning. error_category stays the summary; these columns carry the counts behind it so the
-- Kiosks page can name the cause. NULL means the kiosk release does not report attention details.
-- Additive: the previously deployed Worker never reads or writes these columns.
ALTER TABLE kiosks ADD COLUMN scans_need_review INTEGER;
ALTER TABLE kiosks ADD COLUMN clock_confirmed INTEGER;
ALTER TABLE kiosks ADD COLUMN clock_pending_scans INTEGER;
ALTER TABLE kiosks ADD COLUMN review_sync_failing INTEGER;
