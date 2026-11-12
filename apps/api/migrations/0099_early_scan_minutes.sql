-- The early arrival allowance: a scan up to this many minutes before a meeting starts is accepted as an arrival for that
-- meeting, at the scan's own time. Existing installations get the same 15-minute default as new ones.
-- Meetings saved under the old rule may now overlap by their early arrival windows. Nothing here refuses or moves them: the
-- Worker gives a scan that falls in both an earlier meeting's late scan window and the next meeting's early arrival window
-- to the earlier meeting, and only refuses new overlaps when meetings or allowances are saved.
-- Additive: the previously deployed Worker never reads this column, and its inserts and updates leave it at its value.
ALTER TABLE organization_settings ADD COLUMN early_scan_minutes INTEGER NOT NULL DEFAULT 15 CHECK (early_scan_minutes BETWEEN 0 AND 180);
