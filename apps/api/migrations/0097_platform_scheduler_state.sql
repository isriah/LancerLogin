-- The background scheduler's shared state, read by every scheduler slice whether a Durable Object alarm or the 5-minute
-- cron runs it, and by the Debug page's scheduler status on either kind of deployment.
-- paused_until: an Admin's Stop pauses all outbound delivery until this time (24 hours after the Stop); NULL or a past
--   time means running. Nothing has to clear it: an expired Stop simply no longer applies.
-- jobs_json: each job's next due time, last attempt and last outcome, keyed by job ID.
-- Additive: the previously deployed Worker never reads this table, and an installation without a row runs every job as
-- due. Operational state only, so it is not part of any backup; an installation restore cascades it away.
CREATE TABLE platform_scheduler_state (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  paused_until TEXT,
  paused_at TEXT,
  paused_by TEXT,
  jobs_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(jobs_json) AND json_type(jobs_json) = 'object'),
  updated_at TEXT NOT NULL
);
