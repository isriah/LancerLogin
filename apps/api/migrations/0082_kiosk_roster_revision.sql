-- Kiosk roster generation, separate from report_data_revision. Attendance scans and corrections bump the report
-- revision on every scan; the kiosk roster (active members' IDs and names) changes only with members, so kiosk roster
-- ETags and poll revisions follow this counter and stay cached during a meeting. It starts at the current report
-- revision, so a revision a kiosk already holds still describes the roster it cached, and only grows from there.
-- Additive: the previously deployed Worker keeps reading report_data_revision, whose triggers are unchanged.
CREATE TABLE kiosk_roster_revision (
  installation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO kiosk_roster_revision(installation_id, revision) SELECT installation_id, revision FROM report_data_revision;
INSERT OR IGNORE INTO kiosk_roster_revision(installation_id, revision) VALUES ('primary', 0);

CREATE TRIGGER kiosk_roster_revision_members_insert AFTER INSERT ON members
BEGIN
  UPDATE kiosk_roster_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER kiosk_roster_revision_members_update AFTER UPDATE OF id, installation_id, external_id, first_name, last_name, active ON members
BEGIN
  UPDATE kiosk_roster_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER kiosk_roster_revision_members_delete AFTER DELETE ON members
BEGIN
  UPDATE kiosk_roster_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;
