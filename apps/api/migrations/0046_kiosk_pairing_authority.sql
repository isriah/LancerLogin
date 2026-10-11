-- Existing Community kiosk credentials remain compatible after the web upgrade.
-- Every kiosk paired after this migration binds each queued scan to that pairing.
ALTER TABLE kiosks ADD COLUMN pairing_bound INTEGER NOT NULL DEFAULT 0
CHECK(pairing_bound IN (0, 1));
