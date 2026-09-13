CREATE TABLE documentation_notes_new (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, activity_id TEXT NOT NULL, author_user_id TEXT, author_member_id TEXT,
 source TEXT NOT NULL DEFAULT 'staff' CHECK(source IN ('staff','public','discord')),
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 8000), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT,
 CHECK((review_decision IS NULL AND reviewed_revision IS NULL AND reviewer_user_id IS NULL AND reviewed_at IS NULL) OR (review_decision IS NOT NULL AND reviewed_revision IS NOT NULL AND reviewed_revision>=0 AND reviewed_revision=revision-1 AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK((source='staff' AND author_user_id IS NOT NULL AND author_member_id IS NULL) OR (source IN ('public','discord') AND author_user_id IS NULL AND author_member_id IS NOT NULL)),
 FOREIGN KEY(installation_id,author_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(installation_id,id),
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE documentation_note_revisions_new (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 note_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
 actor_user_id TEXT, actor_member_id TEXT,
 source TEXT NOT NULL DEFAULT 'staff' CHECK(source IN ('staff','public','discord')), text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 8000),
 archived INTEGER NOT NULL CHECK(archived IN (0,1)), created_at TEXT NOT NULL,
 review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT,
 CHECK((review_decision IS NULL AND reviewed_revision IS NULL AND reviewer_user_id IS NULL AND reviewed_at IS NULL) OR (review_decision IS NOT NULL AND reviewed_revision IS NOT NULL AND reviewed_revision>=0 AND reviewed_revision=revision-1 AND reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND actor_user_id IS NOT NULL AND actor_user_id=reviewer_user_id)),
 CHECK((source='staff' AND actor_user_id IS NOT NULL AND actor_member_id IS NULL) OR (source IN ('public','discord') AND actor_user_id IS NULL AND actor_member_id IS NOT NULL AND revision=0)),
 FOREIGN KEY(installation_id,actor_member_id) REFERENCES members(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 PRIMARY KEY(installation_id,note_id,revision),
 FOREIGN KEY(installation_id,note_id) REFERENCES documentation_notes_new(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO documentation_notes_new(installation_id,id,activity_id,author_user_id,text,archived,revision,created_at,updated_at) SELECT installation_id,id,activity_id,author_user_id,text,archived,revision,created_at,updated_at FROM documentation_notes;
INSERT INTO documentation_note_revisions_new(installation_id,note_id,revision,actor_user_id,text,archived,created_at) SELECT installation_id,note_id,revision,actor_user_id,text,archived,created_at FROM documentation_note_revisions;
DROP TABLE documentation_note_revisions;
DROP TABLE documentation_notes;
ALTER TABLE documentation_notes_new RENAME TO documentation_notes;
ALTER TABLE documentation_note_revisions_new RENAME TO documentation_note_revisions;
CREATE INDEX documentation_activity_notes ON documentation_notes(installation_id,activity_id,id);
CREATE TABLE documentation_note_submission_keys (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 channel TEXT NOT NULL CHECK(channel IN ('public','discord')), key_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, note_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,channel,key_hash), UNIQUE(installation_id,note_id),
 FOREIGN KEY(installation_id,note_id) REFERENCES documentation_notes(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
-- Transient admission state: excluded from logical application backups.
CREATE TABLE public_documentation_admission_clock (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 last_seen_ms INTEGER NOT NULL CHECK(last_seen_ms>=0)
);
CREATE TABLE public_documentation_admission (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 policy TEXT NOT NULL, scope TEXT NOT NULL, subject_hash TEXT NOT NULL,
 window_start INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL, capacity INTEGER NOT NULL,
 PRIMARY KEY(installation_id,policy,scope,subject_hash,window_start),
 CONSTRAINT public_documentation_admission_capacity CHECK(attempts BETWEEN 1 AND capacity),
 CHECK(expires_at>window_start AND capacity>0)
);
CREATE INDEX public_documentation_admission_expiry ON public_documentation_admission(installation_id,expires_at);
