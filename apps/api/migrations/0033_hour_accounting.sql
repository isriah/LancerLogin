CREATE UNIQUE INDEX members_installation_identity ON members(installation_id,id);
CREATE TABLE hours_entry_settings (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 reporting_days INTEGER NOT NULL DEFAULT 7 CHECK(reporting_days BETWEEN 1 AND 365),
 reopen_hours INTEGER NOT NULL DEFAULT 24 CHECK(reopen_hours BETWEEN 1 AND 168),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO hours_entry_settings(installation_id) SELECT id FROM installations;
CREATE TABLE hours_reopen_windows (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, activity_id TEXT, starts_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 actor_user_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id), CHECK(expires_ms>starts_ms AND expires_ms-starts_ms<=604800000),
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hours_reopen_active ON hours_reopen_windows(installation_id,revoked,expires_ms);
CREATE TABLE hours_entries (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, activity_id TEXT NOT NULL, member_id TEXT NOT NULL, service_date TEXT NOT NULL,
 time_zone TEXT NOT NULL, start_local TEXT NOT NULL, end_local TEXT NOT NULL,
 end_next_day INTEGER NOT NULL CHECK(end_next_day IN (0,1)), start_occurrence TEXT, end_occurrence TEXT,
 start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, start_offset_seconds INTEGER NOT NULL, end_offset_seconds INTEGER NOT NULL,
 duration_minutes INTEGER NOT NULL CHECK(duration_minutes>0 AND typeof(duration_minutes)='integer'),
 task_notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('counted','void')),
 channel TEXT NOT NULL CHECK(channel IN ('staff','public','discord')),
 attribution TEXT NOT NULL CHECK(attribution IN ('staff_recorded','self_asserted','linked_discord')),
 actor_user_id TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id),
 CHECK(end_ms>start_ms AND end_ms-start_ms=duration_minutes*60000),
 CHECK(start_occurrence IS NULL OR start_occurrence IN ('earlier','later')),
 CHECK(end_occurrence IS NULL OR end_occurrence IN ('earlier','later')),
 FOREIGN KEY(installation_id,member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hours_counted_member_intervals ON hours_entries(installation_id,member_id,status,start_ms,end_ms);
CREATE INDEX hours_entries_dates ON hours_entries(installation_id,service_date,id);
CREATE TRIGGER hours_overlap_insert BEFORE INSERT ON hours_entries WHEN NEW.status='counted' BEGIN
 SELECT RAISE(ABORT,'hours_overlap') WHERE EXISTS(SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.status='counted' AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms);
END;
CREATE TRIGGER hours_overlap_update BEFORE UPDATE ON hours_entries WHEN NEW.status='counted' BEGIN
 SELECT RAISE(ABORT,'hours_overlap') WHERE EXISTS(SELECT 1 FROM hours_entries e WHERE e.installation_id=NEW.installation_id AND e.member_id=NEW.member_id AND e.id!=NEW.id AND e.status='counted' AND e.start_ms<NEW.end_ms AND e.end_ms>NEW.start_ms);
END;
CREATE TABLE hours_entry_revisions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 entry_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), member_id TEXT NOT NULL, activity_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('created','corrected','voided')), reason TEXT NOT NULL,
 actor_user_id TEXT, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,entry_id,revision),
 FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hours_submission_keys (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 channel TEXT NOT NULL CHECK(channel IN ('staff','public','discord')), key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
 entry_id TEXT NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt)), created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,channel,key_hash),
 FOREIGN KEY(installation_id,entry_id) REFERENCES hours_entries(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER hours_activity_date_history BEFORE UPDATE OF service_date ON hours_activities WHEN NEW.service_date!=OLD.service_date BEGIN
 SELECT RAISE(ABORT,'hours_activity_date_history') WHERE EXISTS(SELECT 1 FROM hours_entries WHERE installation_id=OLD.installation_id AND activity_id=OLD.id) OR EXISTS(SELECT 1 FROM hours_entry_revisions WHERE installation_id=OLD.installation_id AND activity_id=OLD.id);
END;
CREATE TRIGGER hours_revision_immutable BEFORE UPDATE ON hours_entry_revisions BEGIN
 SELECT RAISE(ABORT,'hours_revision_immutable');
END;
CREATE TRIGGER hours_receipt_immutable BEFORE UPDATE ON hours_submission_keys BEGIN
 SELECT RAISE(ABORT,'hours_receipt_immutable');
END;
CREATE TRIGGER hours_entry_provenance BEFORE UPDATE ON hours_entries WHEN OLD.status='void' OR NEW.revision!=OLD.revision+1 OR NEW.id!=OLD.id OR NEW.installation_id!=OLD.installation_id OR NEW.time_zone!=OLD.time_zone OR NEW.channel!=OLD.channel OR NEW.attribution!=OLD.attribution OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.created_at!=OLD.created_at BEGIN
 SELECT RAISE(ABORT,'hours_entry_provenance');
END;
