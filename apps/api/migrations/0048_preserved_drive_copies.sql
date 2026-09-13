-- Picker grants are transient; preserve pending sessions while adding the product purpose.
CREATE TABLE google_picker_intents_new (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE,
 actor_user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
 generation TEXT NOT NULL, connection_revision INTEGER NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('root','source','documentation-source')),
 status TEXT NOT NULL CHECK(status IN ('pending','exchanging','ready','claimed','selected')),
 expires_at INTEGER NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL,
 PRIMARY KEY(installation_id,id),
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) ON DELETE CASCADE
);
INSERT INTO google_picker_intents_new SELECT * FROM google_picker_intents;
DROP TABLE google_picker_intents;
ALTER TABLE google_picker_intents_new RENAME TO google_picker_intents;

-- Preserve cascading children and real historical claim pins during parent rebuild.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE wu165_claim_artifact_pins AS SELECT * FROM documentation_claim_revision_artifacts;
DELETE FROM documentation_claim_revision_artifacts;
CREATE TABLE wu165_documentation_artifact_activities AS SELECT * FROM documentation_artifact_activities;
CREATE TABLE wu165_documentation_artifact_revision_activities AS SELECT * FROM documentation_artifact_revision_activities;
CREATE TABLE wu165_documentation_artifact_initiatives AS SELECT * FROM documentation_artifact_initiatives;
CREATE TABLE wu165_documentation_artifact_revision_initiatives AS SELECT * FROM documentation_artifact_revision_initiatives;
CREATE TABLE wu165_documentation_artifact_reviews AS SELECT * FROM documentation_artifact_reviews;
CREATE TABLE documentation_artifacts_new (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'external-link' CHECK(kind IN ('external-link','file','preserved-drive')), file_id TEXT, file_root_id TEXT, file_generation TEXT, file_sha256 TEXT, file_size INTEGER, file_mime TEXT, file_source_id TEXT, file_source_version TEXT, file_copied_at TEXT, file_version TEXT, validation_outcome TEXT CHECK(validation_outcome IN ('embedded','linked-only','native')), title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), caption TEXT NOT NULL CHECK(length(caption)<=4000), url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048), original_url TEXT NOT NULL CHECK(length(original_url) BETWEEN 1 AND 2048), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), author_user_id TEXT, author_member_id TEXT, source TEXT NOT NULL DEFAULT 'staff' CHECK(source IN ('staff','public','discord')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((kind='external-link' AND file_id IS NULL AND file_root_id IS NULL AND file_generation IS NULL AND file_sha256 IS NULL AND file_size IS NULL AND file_mime IS NULL AND validation_outcome IS NULL AND file_source_id IS NULL AND file_source_version IS NULL AND file_copied_at IS NULL AND file_version IS NULL) OR (kind='file' AND file_id IS NOT NULL AND file_root_id IS NOT NULL AND file_generation IS NOT NULL AND file_sha256 IS NOT NULL AND length(file_sha256)=64 AND file_size IS NOT NULL AND file_size BETWEEN 1 AND 4194304 AND file_mime IS NOT NULL AND validation_outcome IN ('embedded','linked-only') AND file_source_id IS NULL AND file_source_version IS NULL AND file_copied_at IS NULL AND file_version IS NULL) OR (kind='preserved-drive' AND file_id IS NOT NULL AND file_root_id IS NOT NULL AND file_generation IS NOT NULL AND file_mime IS NOT NULL AND file_source_id IS NOT NULL AND file_source_version IS NOT NULL AND file_copied_at IS NOT NULL AND file_version IS NOT NULL AND ((validation_outcome='native' AND file_size IS NULL AND file_sha256 IS NULL) OR (validation_outcome IN ('embedded','linked-only') AND file_size IS NOT NULL AND file_size BETWEEN 1 AND 4194304 AND file_sha256 IS NOT NULL AND length(file_sha256)=64)))),
 CHECK((source='staff' AND author_user_id IS NOT NULL AND author_member_id IS NULL) OR (source IN ('public','discord') AND author_user_id IS NULL AND author_member_id IS NOT NULL)), FOREIGN KEY(installation_id,author_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(installation_id,id), FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_revisions_new (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), actor_user_id TEXT, actor_member_id TEXT,
 kind TEXT NOT NULL DEFAULT 'external-link' CHECK(kind IN ('external-link','file','preserved-drive')), file_id TEXT, file_root_id TEXT, file_generation TEXT, file_sha256 TEXT, file_size INTEGER, file_mime TEXT, file_source_id TEXT, file_source_version TEXT, file_copied_at TEXT, file_version TEXT, validation_outcome TEXT CHECK(validation_outcome IN ('embedded','linked-only','native')), title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), caption TEXT NOT NULL CHECK(length(caption)<=4000), url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048), original_url TEXT NOT NULL CHECK(length(original_url) BETWEEN 1 AND 2048), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, created_at TEXT NOT NULL,
 CHECK((kind='external-link' AND file_id IS NULL AND file_root_id IS NULL AND file_generation IS NULL AND file_sha256 IS NULL AND file_size IS NULL AND file_mime IS NULL AND validation_outcome IS NULL AND file_source_id IS NULL AND file_source_version IS NULL AND file_copied_at IS NULL AND file_version IS NULL) OR (kind='file' AND file_id IS NOT NULL AND file_root_id IS NOT NULL AND file_generation IS NOT NULL AND file_sha256 IS NOT NULL AND length(file_sha256)=64 AND file_size IS NOT NULL AND file_size BETWEEN 1 AND 4194304 AND file_mime IS NOT NULL AND validation_outcome IN ('embedded','linked-only') AND file_source_id IS NULL AND file_source_version IS NULL AND file_copied_at IS NULL AND file_version IS NULL) OR (kind='preserved-drive' AND file_id IS NOT NULL AND file_root_id IS NOT NULL AND file_generation IS NOT NULL AND file_mime IS NOT NULL AND file_source_id IS NOT NULL AND file_source_version IS NOT NULL AND file_copied_at IS NOT NULL AND file_version IS NOT NULL AND ((validation_outcome='native' AND file_size IS NULL AND file_sha256 IS NULL) OR (validation_outcome IN ('embedded','linked-only') AND file_size IS NOT NULL AND file_size BETWEEN 1 AND 4194304 AND file_sha256 IS NOT NULL AND length(file_sha256)=64)))),
 CHECK((actor_user_id IS NULL)!=(actor_member_id IS NULL)), FOREIGN KEY(installation_id,actor_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(installation_id,artifact_id,revision),
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts_new(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO documentation_artifacts_new(installation_id,id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,kind,file_id,file_root_id,file_generation,file_sha256,file_size,file_mime,validation_outcome,revision,author_user_id,author_member_id,source,created_at,updated_at) SELECT installation_id,id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,kind,file_id,file_root_id,file_generation,file_sha256,file_size,file_mime,validation_outcome,revision,author_user_id,author_member_id,source,created_at,updated_at FROM documentation_artifacts;
INSERT INTO documentation_artifact_revisions_new(installation_id,artifact_id,revision,actor_user_id,actor_member_id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,kind,file_id,file_root_id,file_generation,file_sha256,file_size,file_mime,validation_outcome,created_at) SELECT installation_id,artifact_id,revision,actor_user_id,actor_member_id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,kind,file_id,file_root_id,file_generation,file_sha256,file_size,file_mime,validation_outcome,created_at FROM documentation_artifact_revisions;
DROP TABLE documentation_artifact_revisions;
DROP TABLE documentation_artifacts;
ALTER TABLE documentation_artifacts_new RENAME TO documentation_artifacts;
ALTER TABLE documentation_artifact_revisions_new RENAME TO documentation_artifact_revisions;
INSERT INTO documentation_artifact_activities SELECT * FROM wu165_documentation_artifact_activities;
DROP TABLE wu165_documentation_artifact_activities;
INSERT INTO documentation_artifact_revision_activities SELECT * FROM wu165_documentation_artifact_revision_activities;
DROP TABLE wu165_documentation_artifact_revision_activities;
INSERT INTO documentation_artifact_initiatives SELECT * FROM wu165_documentation_artifact_initiatives;
DROP TABLE wu165_documentation_artifact_initiatives;
INSERT INTO documentation_artifact_revision_initiatives SELECT * FROM wu165_documentation_artifact_revision_initiatives;
DROP TABLE wu165_documentation_artifact_revision_initiatives;
INSERT INTO documentation_artifact_reviews SELECT * FROM wu165_documentation_artifact_reviews;
DROP TABLE wu165_documentation_artifact_reviews;

INSERT INTO documentation_claim_revision_artifacts SELECT * FROM wu165_claim_artifact_pins;
DROP TABLE wu165_claim_artifact_pins;
CREATE TABLE documentation_drive_copy_operations (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL,
 author_user_id TEXT NOT NULL, request_hash TEXT NOT NULL, key_hash TEXT NOT NULL,
 title TEXT NOT NULL, caption TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL,
 source_json TEXT NOT NULL CHECK(json_valid(source_json)), resource_ciphertext TEXT, resource_iv TEXT,
 activities_json TEXT NOT NULL CHECK(json_valid(activities_json)), initiatives_json TEXT NOT NULL CHECK(json_valid(initiatives_json)), section_revision INTEGER NOT NULL,
 root_id TEXT NOT NULL, root_revision INTEGER NOT NULL, connection_generation TEXT NOT NULL, connection_iv TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ready','reconciling','validating','saved','failed')),
 dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)), file_id TEXT, file_version TEXT, copied_at TEXT,
 compute_id TEXT, manifest_digest TEXT, snapshot_digest TEXT, validation_outcome TEXT CHECK(validation_outcome IN ('native','embedded','linked-only')),
 lease_token TEXT, lease_expires_ms INTEGER NOT NULL DEFAULT 0, artifact_id TEXT, error_code TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((resource_ciphertext IS NULL)=(resource_iv IS NULL)),
 PRIMARY KEY(installation_id,id), UNIQUE(installation_id,author_user_id,key_hash), UNIQUE(installation_id,file_id),
 FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_drive_copy_restore_guard(installation_id TEXT PRIMARY KEY,operations_json TEXT NOT NULL CHECK(json_valid(operations_json)));
CREATE TRIGGER documentation_drive_copy_live_guard BEFORE DELETE ON installations
WHEN EXISTS(SELECT 1 FROM documentation_drive_copy_operations WHERE installation_id=OLD.id AND (lease_expires_ms>unixepoch('subsec')*1000 OR (dispatched=1 AND state!='saved')))
BEGIN SELECT RAISE(ABORT,'documentation_drive_copy_in_flight'); END;
CREATE TRIGGER documentation_drive_copy_inventory_guard BEFORE DELETE ON installations
WHEN EXISTS(SELECT 1 FROM documentation_drive_copy_operations o WHERE o.installation_id=OLD.id AND o.dispatched=1 AND NOT EXISTS(
 SELECT 1 FROM documentation_drive_copy_restore_guard r,json_each(r.operations_json) b WHERE r.installation_id=OLD.id
 AND json_extract(b.value,'$.id')=o.id AND json_extract(b.value,'$.file_id') IS o.file_id AND json_extract(b.value,'$.root_id')=o.root_id
 AND json_extract(b.value,'$.connection_generation')=o.connection_generation AND json_extract(b.value,'$.source_id')=o.source_id
 AND json_extract(b.value,'$.source_version')=o.source_version AND json_extract(b.value,'$.source_json')=o.source_json
 AND json_extract(b.value,'$.artifact_id') IS o.artifact_id))
BEGIN SELECT RAISE(ABORT,'documentation_drive_copy_inventory'); END;
