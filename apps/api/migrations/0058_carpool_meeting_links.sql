ALTER TABLE carpool_plans ADD COLUMN meeting_id TEXT;

CREATE INDEX carpool_plans_meeting_reference
  ON carpool_plans(installation_id,meeting_id,archived);
