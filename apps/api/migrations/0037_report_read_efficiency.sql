-- Additive indexes retain compatibility with the previously deployed Worker.
CREATE INDEX idx_corrections_member_meeting_latest
  ON attendance_corrections(member_id, meeting_id, created_at DESC, id DESC);
CREATE INDEX idx_events_member_meeting_action_time
  ON attendance_events(member_id, meeting_id, action, occurred_at);
CREATE INDEX idx_contests_member_history
  ON discord_attendance_contests(installation_id, member_id);
CREATE INDEX idx_events_installation_meeting
  ON attendance_events(installation_id, meeting_id, occurred_at, id);
CREATE INDEX idx_corrections_installation_meeting
  ON attendance_corrections(installation_id, meeting_id, created_at, id);

CREATE INDEX idx_events_installation_member_time
  ON attendance_events(installation_id, member_id, occurred_at, id);
CREATE INDEX idx_corrections_installation_member_time
  ON attendance_corrections(installation_id, member_id, created_at, id);

-- Operational cache generation stays out of portable backups. All Worker
-- instances check it before reuse; direct SQL and category restores invalidate too.
CREATE TABLE report_data_revision (
  installation_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO report_data_revision(installation_id, revision) VALUES ('primary', 0);

CREATE TRIGGER report_revision_members_insert AFTER INSERT ON members
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_members_update AFTER UPDATE ON members
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_members_delete AFTER DELETE ON members
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_member_labels_insert AFTER INSERT ON member_labels
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_member_labels_update AFTER UPDATE ON member_labels
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_member_labels_delete AFTER DELETE ON member_labels
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_member_label_changes_insert AFTER INSERT ON member_label_changes
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_member_label_changes_update AFTER UPDATE ON member_label_changes
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_member_label_changes_delete AFTER DELETE ON member_label_changes
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_label_attendance_rules_insert AFTER INSERT ON label_attendance_rules
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_label_attendance_rules_update AFTER UPDATE ON label_attendance_rules
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_label_attendance_rules_delete AFTER DELETE ON label_attendance_rules
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_meetings_insert AFTER INSERT ON meetings
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_meetings_update AFTER UPDATE ON meetings
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_meetings_delete AFTER DELETE ON meetings
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_meeting_audience_labels_insert AFTER INSERT ON meeting_audience_labels
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_meeting_audience_labels_update AFTER UPDATE ON meeting_audience_labels
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_meeting_audience_labels_delete AFTER DELETE ON meeting_audience_labels
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_attendance_events_insert AFTER INSERT ON attendance_events
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_attendance_events_update AFTER UPDATE ON attendance_events
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_attendance_events_delete AFTER DELETE ON attendance_events
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_attendance_corrections_insert AFTER INSERT ON attendance_corrections
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_attendance_corrections_update AFTER UPDATE ON attendance_corrections
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_attendance_corrections_delete AFTER DELETE ON attendance_corrections
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;

CREATE TRIGGER report_revision_organization_settings_insert AFTER INSERT ON organization_settings
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = NEW.installation_id;
END;

CREATE TRIGGER report_revision_organization_settings_update AFTER UPDATE ON organization_settings
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id IN (OLD.installation_id, NEW.installation_id);
END;

CREATE TRIGGER report_revision_organization_settings_delete AFTER DELETE ON organization_settings
BEGIN
  UPDATE report_data_revision SET revision = revision + 1 WHERE installation_id = OLD.installation_id;
END;
