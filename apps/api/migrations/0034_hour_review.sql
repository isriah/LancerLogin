CREATE TABLE hours_correction_requests (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('public','discord')),
 attribution TEXT NOT NULL CHECK((channel='public' AND attribution='self_asserted') OR (channel='discord' AND attribution='linked_discord')),
 requester_member_id TEXT, claimed_member_id TEXT, claimed_receipt_id TEXT, claimed_activity_id TEXT, claimed_service_date TEXT,
 message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
 key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, resolved_at TEXT,
 PRIMARY KEY(installation_id,id), UNIQUE(installation_id,channel,key_hash),
 CHECK((status='open' AND revision=0 AND resolved_at IS NULL) OR (status='resolved' AND revision=1 AND resolved_at IS NOT NULL)),
 CHECK(channel!='discord' OR requester_member_id IS NOT NULL),
 FOREIGN KEY(installation_id,requester_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hours_correction_inbox ON hours_correction_requests(installation_id,status,id);
CREATE INDEX hours_correction_member ON hours_correction_requests(installation_id,requester_member_id);
CREATE TABLE hours_correction_resolutions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('acknowledged','dismissed','corrected','voided')),
 note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 4000), actor_user_id TEXT NOT NULL,
 entry_id TEXT, entry_revision INTEGER, created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,request_id),
 CHECK((entry_id IS NULL AND entry_revision IS NULL) OR (entry_id IS NOT NULL AND entry_revision>=0)),
 CHECK(action NOT IN ('corrected','voided') OR entry_id IS NOT NULL),
 FOREIGN KEY(installation_id,request_id) REFERENCES hours_correction_requests(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,entry_id,entry_revision) REFERENCES hours_entry_revisions(installation_id,entry_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER hours_request_immutable BEFORE UPDATE ON hours_correction_requests
WHEN OLD.status!='open' OR NEW.status!='resolved' OR NEW.revision!=1 OR NEW.resolved_at IS NULL
 OR NEW.installation_id IS NOT OLD.installation_id OR NEW.id IS NOT OLD.id OR NEW.channel IS NOT OLD.channel
 OR NEW.attribution IS NOT OLD.attribution OR NEW.requester_member_id IS NOT OLD.requester_member_id
 OR NEW.claimed_member_id IS NOT OLD.claimed_member_id OR NEW.claimed_receipt_id IS NOT OLD.claimed_receipt_id
 OR NEW.claimed_activity_id IS NOT OLD.claimed_activity_id OR NEW.claimed_service_date IS NOT OLD.claimed_service_date
 OR NEW.message IS NOT OLD.message OR NEW.key_hash IS NOT OLD.key_hash OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'hours_request_immutable'); END;
CREATE TRIGGER hours_resolution_immutable BEFORE UPDATE ON hours_correction_resolutions
BEGIN SELECT RAISE(ABORT,'hours_resolution_immutable'); END;
