-- Recurring meetings are expanded into independently editable occurrences.
ALTER TABLE meetings ADD COLUMN series_id TEXT;
ALTER TABLE meetings ADD COLUMN recurrence_frequency TEXT CHECK (recurrence_frequency IN ('daily', 'weekly', 'biweekly', 'monthly'));
ALTER TABLE meetings ADD COLUMN recurrence_until TEXT;
ALTER TABLE meetings ADD COLUMN recurrence_sequence INTEGER;

CREATE INDEX IF NOT EXISTS idx_meetings_series
ON meetings(installation_id, series_id, starts_at);
