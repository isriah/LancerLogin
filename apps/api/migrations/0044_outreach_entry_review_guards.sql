CREATE TRIGGER hours_entry_provenance BEFORE UPDATE ON hours_entries
WHEN OLD.status='void' OR NEW.revision!=OLD.revision+1
  OR NEW.installation_id!=OLD.installation_id OR NEW.id!=OLD.id OR NEW.time_zone!=OLD.time_zone
  OR NEW.channel!=OLD.channel OR NEW.attribution!=OLD.attribution OR NEW.actor_user_id IS NOT OLD.actor_user_id
  OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'hours_entry_provenance'); END;

CREATE TRIGGER hours_entry_revision_immutable BEFORE UPDATE ON hours_entry_revisions
BEGIN SELECT RAISE(ABORT,'hours_entry_revision_immutable'); END;

CREATE TRIGGER hours_submission_receipt_immutable BEFORE UPDATE ON hours_submission_keys
BEGIN SELECT RAISE(ABORT,'hours_submission_receipt_immutable'); END;

CREATE TRIGGER hours_activity_date_history BEFORE UPDATE OF service_date ON hours_activities
WHEN NEW.service_date!=OLD.service_date AND (
  EXISTS(SELECT 1 FROM hours_entries WHERE installation_id=OLD.installation_id AND activity_id=OLD.id)
  OR EXISTS(SELECT 1 FROM hours_entry_revisions WHERE installation_id=OLD.installation_id AND activity_id=OLD.id)
)
BEGIN SELECT RAISE(ABORT,'hours_activity_date_history'); END;
