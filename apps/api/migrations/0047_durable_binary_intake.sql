-- Preserve cascading children and real historical claim pins during parent rebuild.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE wu162_claim_artifact_pins AS SELECT * FROM documentation_claim_revision_artifacts;
DELETE FROM documentation_claim_revision_artifacts;
CREATE TABLE wu162_documentation_artifact_activities AS SELECT * FROM documentation_artifact_activities;
CREATE TABLE wu162_documentation_artifact_revision_activities AS SELECT * FROM documentation_artifact_revision_activities;
CREATE TABLE wu162_documentation_artifact_initiatives AS SELECT * FROM documentation_artifact_initiatives;
CREATE TABLE wu162_documentation_artifact_revision_initiatives AS SELECT * FROM documentation_artifact_revision_initiatives;
CREATE TABLE wu162_documentation_artifact_reviews AS SELECT * FROM documentation_artifact_reviews;
CREATE TABLE documentation_artifacts_new (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'external-link' CHECK(kind IN ('external-link','file')), file_id TEXT, file_root_id TEXT, file_generation TEXT, file_sha256 TEXT, file_size INTEGER, file_mime TEXT, validation_outcome TEXT CHECK(validation_outcome IN ('embedded','linked-only')), title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), caption TEXT NOT NULL CHECK(length(caption)<=4000), url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048), original_url TEXT NOT NULL CHECK(length(original_url) BETWEEN 1 AND 2048), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), author_user_id TEXT, author_member_id TEXT, source TEXT NOT NULL DEFAULT 'staff' CHECK(source IN ('staff','public','discord')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((kind='external-link' AND file_id IS NULL AND file_root_id IS NULL AND file_generation IS NULL AND file_sha256 IS NULL AND file_size IS NULL AND file_mime IS NULL AND validation_outcome IS NULL) OR (kind='file' AND file_id IS NOT NULL AND file_root_id IS NOT NULL AND file_generation IS NOT NULL AND file_sha256 IS NOT NULL AND length(file_sha256)=64 AND file_size IS NOT NULL AND file_size BETWEEN 1 AND 4194304 AND file_mime IS NOT NULL AND validation_outcome IS NOT NULL)),
 CHECK((source='staff' AND author_user_id IS NOT NULL AND author_member_id IS NULL) OR (source IN ('public','discord') AND author_user_id IS NULL AND author_member_id IS NOT NULL)), FOREIGN KEY(installation_id,author_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(installation_id,id), FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_revisions_new (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), actor_user_id TEXT, actor_member_id TEXT,
 kind TEXT NOT NULL DEFAULT 'external-link' CHECK(kind IN ('external-link','file')), file_id TEXT, file_root_id TEXT, file_generation TEXT, file_sha256 TEXT, file_size INTEGER, file_mime TEXT, validation_outcome TEXT CHECK(validation_outcome IN ('embedded','linked-only')), title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), caption TEXT NOT NULL CHECK(length(caption)<=4000), url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048), original_url TEXT NOT NULL CHECK(length(original_url) BETWEEN 1 AND 2048), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, created_at TEXT NOT NULL,
 CHECK((kind='external-link' AND file_id IS NULL AND file_root_id IS NULL AND file_generation IS NULL AND file_sha256 IS NULL AND file_size IS NULL AND file_mime IS NULL AND validation_outcome IS NULL) OR (kind='file' AND file_id IS NOT NULL AND file_root_id IS NOT NULL AND file_generation IS NOT NULL AND file_sha256 IS NOT NULL AND length(file_sha256)=64 AND file_size IS NOT NULL AND file_size BETWEEN 1 AND 4194304 AND file_mime IS NOT NULL AND validation_outcome IS NOT NULL)),
 CHECK((actor_user_id IS NULL)!=(actor_member_id IS NULL)), FOREIGN KEY(installation_id,actor_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(installation_id,artifact_id,revision),
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts_new(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO documentation_artifacts_new(installation_id,id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,revision,author_user_id,created_at,updated_at) SELECT installation_id,id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,revision,author_user_id,created_at,updated_at FROM documentation_artifacts;
INSERT INTO documentation_artifact_revisions_new(installation_id,artifact_id,revision,actor_user_id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,created_at) SELECT installation_id,artifact_id,revision,actor_user_id,title,caption,url,original_url,archived,review_decision,reviewed_revision,reviewer_user_id,reviewed_at,created_at FROM documentation_artifact_revisions;
DROP TABLE documentation_artifact_revisions;
DROP TABLE documentation_artifacts;
ALTER TABLE documentation_artifacts_new RENAME TO documentation_artifacts;
ALTER TABLE documentation_artifact_revisions_new RENAME TO documentation_artifact_revisions;
INSERT INTO documentation_artifact_activities SELECT * FROM wu162_documentation_artifact_activities;
DROP TABLE wu162_documentation_artifact_activities;
INSERT INTO documentation_artifact_revision_activities SELECT * FROM wu162_documentation_artifact_revision_activities;
DROP TABLE wu162_documentation_artifact_revision_activities;
INSERT INTO documentation_artifact_initiatives SELECT * FROM wu162_documentation_artifact_initiatives;
DROP TABLE wu162_documentation_artifact_initiatives;
INSERT INTO documentation_artifact_revision_initiatives SELECT * FROM wu162_documentation_artifact_revision_initiatives;
DROP TABLE wu162_documentation_artifact_revision_initiatives;
INSERT INTO documentation_artifact_reviews SELECT * FROM wu162_documentation_artifact_reviews;
DROP TABLE wu162_documentation_artifact_reviews;

INSERT INTO documentation_claim_revision_artifacts SELECT * FROM wu162_claim_artifact_pins;
DROP TABLE wu162_claim_artifact_pins;
CREATE TABLE documentation_upload_operations (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('staff','public','discord')), author_user_id TEXT, author_member_id TEXT,
 request_hash TEXT NOT NULL, key_hash TEXT NOT NULL, ticket_hash TEXT, ticket_expires_ms INTEGER NOT NULL,
 title TEXT NOT NULL, caption TEXT NOT NULL, mime TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 4194304), sha256 TEXT NOT NULL,
 activities_json TEXT NOT NULL CHECK(json_valid(activities_json)), initiatives_json TEXT NOT NULL CHECK(json_valid(initiatives_json)), section_revision INTEGER NOT NULL,
 root_id TEXT NOT NULL, root_revision INTEGER NOT NULL, connection_generation TEXT NOT NULL, connection_iv TEXT NOT NULL,
 discord_iv TEXT, discord_user_id TEXT,
 compute_id TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)), manifest_digest TEXT, snapshot_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('uploading','validating','ready','preserving','reconciling','saved','failed','expired')),
 next_chunk INTEGER NOT NULL DEFAULT 0, validation_outcome TEXT CHECK(validation_outcome IN ('embedded','linked-only')),
 file_id TEXT, dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)), session_ciphertext TEXT, session_iv TEXT, upload_offset INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_expires_ms INTEGER NOT NULL DEFAULT 0, artifact_id TEXT, error_code TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((source='staff' AND author_user_id IS NOT NULL AND author_member_id IS NULL) OR (source IN ('public','discord') AND author_user_id IS NULL AND author_member_id IS NOT NULL)),
 CHECK((session_ciphertext IS NULL)=(session_iv IS NULL)), CHECK(dispatched=0 OR file_id IS NOT NULL),
 PRIMARY KEY(installation_id,id), UNIQUE(installation_id,source,key_hash), UNIQUE(installation_id,file_id),
 FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,author_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_upload_restore_guard(installation_id TEXT PRIMARY KEY,operations_json TEXT NOT NULL CHECK(json_valid(operations_json)));
CREATE TRIGGER documentation_upload_live_guard BEFORE DELETE ON installations
WHEN EXISTS(SELECT 1 FROM documentation_upload_operations WHERE installation_id=OLD.id AND (lease_expires_ms>unixepoch('subsec')*1000 OR (dispatched=1 AND state!='saved')))
BEGIN SELECT RAISE(ABORT,'documentation_upload_in_flight'); END;
CREATE TRIGGER documentation_upload_inventory_guard BEFORE DELETE ON installations
WHEN EXISTS(SELECT 1 FROM documentation_upload_restore_guard WHERE installation_id=OLD.id)
AND EXISTS(SELECT 1 FROM documentation_upload_operations o WHERE o.installation_id=OLD.id AND o.file_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM documentation_upload_restore_guard r,json_each(r.operations_json) b WHERE r.installation_id=OLD.id
 AND json_extract(b.value,'$.id')=o.id AND json_extract(b.value,'$.file_id')=o.file_id AND json_extract(b.value,'$.root_id')=o.root_id
 AND json_extract(b.value,'$.connection_generation')=o.connection_generation AND json_extract(b.value,'$.sha256')=o.sha256
 AND json_extract(b.value,'$.byte_length')=o.byte_length AND json_extract(b.value,'$.artifact_id') IS o.artifact_id))
BEGIN SELECT RAISE(ABORT,'documentation_upload_inventory'); END;
