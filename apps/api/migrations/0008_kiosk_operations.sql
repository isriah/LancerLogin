ALTER TABLE kiosks ADD COLUMN pending_events INTEGER NOT NULL DEFAULT 0 CHECK (pending_events >= 0);
ALTER TABLE kiosks ADD COLUMN last_sync_at TEXT;
ALTER TABLE kiosks ADD COLUMN error_category TEXT CHECK (error_category IN ('cloud_sync', 'reader', 'offline_queue'));
