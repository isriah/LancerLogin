-- Calendar work for meetings is now only queued by requests and delivered by the scheduled Google Calendar and Discord
-- jobs. This migration gives those jobs, and the Discord notice and anomaly-report jobs, indexes for the scans they make
-- every five minutes, which searched by installation alone and sorted in a temporary B-tree, and a place to record
-- remote events that must still be deleted after their meetings are gone.
-- Additive: the previously deployed Worker never reads the new table or column, and its queries and writes work
-- unchanged with the new indexes and the adjusted next_attempt_at values below. Operations and mappings already stored
-- still deliver.

-- A Discord operation carries its meeting's start, as a Google operation always has, so both queues can deliver the
-- soonest meeting first. A delete has none.
ALTER TABLE discord_calendar_operations ADD COLUMN starts_at TEXT;

-- An operation is due once its next_attempt_at has passed. Work queued by a meeting change is due at once and carries
-- the earliest time there is, 1970-01-01T00:00:00.000Z, so that among it the index orders by meeting start: deletes
-- first (no start), then the soonest meeting. A retry, a Discord upsert waiting for the 60-day horizon and a delivery
-- whose lease ran out keep a real time and follow. Delivered operations and failures nothing will retry are not in
-- these indexes, so a pass reads only what it can deliver.
CREATE INDEX idx_google_calendar_operations_queue ON google_calendar_operations (installation_id, next_attempt_at, starts_at)
  WHERE status != 'delivered' AND next_attempt_at IS NOT NULL;
CREATE INDEX idx_discord_calendar_operations_queue ON discord_calendar_operations (installation_id, next_attempt_at, starts_at)
  WHERE status != 'delivered' AND next_attempt_at IS NOT NULL;

-- The notice and anomaly-report jobs look for meetings by when they ended.
CREATE INDEX idx_meetings_ended ON meetings (installation_id, ends_at)
  WHERE deleted_at IS NULL AND is_test = 0 AND ends_at IS NOT NULL;

-- Stored operations take the shape the delivery jobs now read.
UPDATE discord_calendar_operations
SET starts_at = (SELECT m.starts_at FROM meetings m WHERE m.installation_id = discord_calendar_operations.installation_id AND m.id = discord_calendar_operations.meeting_id)
WHERE action = 'upsert' AND status != 'delivered';
-- Every pending operation is due at once.
UPDATE google_calendar_operations SET next_attempt_at = '1970-01-01T00:00:00.000Z' WHERE status = 'pending';
UPDATE discord_calendar_operations SET next_attempt_at = '1970-01-01T00:00:00.000Z' WHERE status = 'pending';
-- A Discord operation being delivered is due again when its lease ends, so a delivery that died is retried.
UPDATE discord_calendar_operations SET next_attempt_at = COALESCE(lease_expires_at, updated_at) WHERE status = 'processing';
-- Discord allows a server 100 scheduled events, so an upsert for a meeting more than 60 days out with no event yet
-- waits. It used to stay due and be skipped on every pass; it now falls due when its meeting comes within 60 days.
UPDATE discord_calendar_operations
SET next_attempt_at = (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', julianday(m.starts_at) - 60) FROM meetings m WHERE m.installation_id = discord_calendar_operations.installation_id AND m.id = discord_calendar_operations.meeting_id)
WHERE status = 'pending' AND action = 'upsert'
  AND EXISTS (SELECT 1 FROM meetings m WHERE m.installation_id = discord_calendar_operations.installation_id AND m.id = discord_calendar_operations.meeting_id AND julianday(m.starts_at) > julianday('now') + 60)
  AND NOT EXISTS (SELECT 1 FROM discord_calendar_event_mappings d WHERE d.installation_id = discord_calendar_operations.installation_id AND d.meeting_id = discord_calendar_operations.meeting_id AND d.generation = discord_calendar_operations.generation AND d.event_id IS NOT NULL);

-- Delete attendance data and restoring a meetings backup remove meetings outright, and their calendar mappings and
-- operations go with them. The remote events that may still exist are recorded here first, one row per event, and the
-- delivery jobs delete them and then the rows. `target` identifies the calendar or server the event is on (a hash of
-- the Google calendar id; the Discord server id), so a removal is never sent to a different one. A removal the provider
-- refuses is retried ten times over about three days; after that it stays here with no next attempt, shown on the
-- integration card as needing another attempt, until an Admin retries it. No meeting is referenced, so the rows outlive
-- the meetings. Short-lived and bound to one provider account, so not part of backups.
CREATE TABLE calendar_event_removals (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_calendar', 'discord')),
  event_id TEXT NOT NULL,
  target TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, provider, event_id)
);

CREATE INDEX idx_calendar_event_removals_due ON calendar_event_removals (installation_id, provider, next_attempt_at);
