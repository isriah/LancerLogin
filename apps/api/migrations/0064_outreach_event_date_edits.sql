-- Planned Event dates can change without rewriting recorded participation.
-- Retain the dated identity guard for Team support and Other service.
DROP TRIGGER hours_activity_date_history;
CREATE TRIGGER hours_activity_date_history BEFORE UPDATE OF service_date ON hours_activities
WHEN NEW.service_date!=OLD.service_date AND (OLD.mode!='event' OR NEW.mode!='event') AND (
  EXISTS(SELECT 1 FROM hours_entries WHERE installation_id=OLD.installation_id AND activity_id=OLD.id)
  OR EXISTS(SELECT 1 FROM hours_entry_revisions WHERE installation_id=OLD.installation_id AND activity_id=OLD.id)
)
BEGIN SELECT RAISE(ABORT,'hours_activity_date_history'); END;
