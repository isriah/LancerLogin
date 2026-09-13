CREATE TABLE documentation_sections (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version=1), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 notes_enabled INTEGER NOT NULL DEFAULT 1 CHECK(notes_enabled IN (0,1)),
 summary_enabled INTEGER NOT NULL DEFAULT 1 CHECK(summary_enabled IN (0,1))
);
INSERT INTO documentation_sections(installation_id) SELECT id FROM installations;
CREATE TABLE documentation_notes (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, activity_id TEXT NOT NULL, author_user_id TEXT NOT NULL,
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 8000), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id),
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX documentation_activity_notes ON documentation_notes(installation_id,activity_id,id);
CREATE TABLE documentation_note_revisions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 note_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
 actor_user_id TEXT NOT NULL, text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 8000),
 archived INTEGER NOT NULL CHECK(archived IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,note_id,revision),
 FOREIGN KEY(installation_id,note_id) REFERENCES documentation_notes(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
