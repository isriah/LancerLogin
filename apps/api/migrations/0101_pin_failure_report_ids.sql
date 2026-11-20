-- Report ids for wrong PIN tries made offline. A kiosk names each report it sends to /kiosk/pin-failures and uses the
-- same id whenever it sends that report again. The Worker records the id, with the number of tries it counted, in the
-- same batch that applies the report, so a report whose answer was lost on the way back is not counted a second time:
-- the repeat is answered with the recorded number. Ids are per kiosk, and are removed after 30 days by the report
-- request itself and by the scheduled clean-up. Short-lived and bound to a kiosk credential, so not part of backups.
-- Additive: the previously deployed Worker never reads this table, and a kiosk that sends no id is answered as before.
CREATE TABLE kiosk_pin_failure_reports (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kiosk_id TEXT NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL,
  recorded INTEGER NOT NULL CHECK (recorded >= 0),
  applied_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, kiosk_id, report_id)
);

-- A scan sent with no PIN to a Require PIN kiosk looks up when Require PIN was last turned on for that kiosk, from the
-- audit of the kiosk's method change. A kiosk that has not been updated repeats that scan, and so the lookup, on every
-- retry, and audit_log had no index. Partial, so only method changes are indexed and no other audit row pays for it.
-- The lookup names the same action and target type, which is what lets SQLite use a partial index.
CREATE INDEX audit_log_kiosk_method_updates ON audit_log(installation_id, target_id, created_at)
  WHERE action = 'kiosk.authentication_method_updated' AND target_type = 'kiosk';
