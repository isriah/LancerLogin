-- Track future inactivity without inventing dates for previously inactive members.
ALTER TABLE members ADD COLUMN inactive_periods_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(inactive_periods_json) AND json_type(inactive_periods_json) = 'array');

UPDATE members
SET inactive_periods_json = json_array(json_array(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL))
WHERE active = 0;
