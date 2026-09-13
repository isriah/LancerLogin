ALTER TABLE documentation_sections ADD COLUMN files_enabled INTEGER NOT NULL DEFAULT 1 CHECK(files_enabled IN (0,1));
CREATE TABLE google_drive_storage (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>=1), root_id TEXT NOT NULL, root_name TEXT NOT NULL,
 generation TEXT NOT NULL, verified_iv TEXT, verified_at TEXT,
 CHECK((verified_iv IS NULL)=(verified_at IS NULL))
);
CREATE TABLE documentation_artifacts (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), caption TEXT NOT NULL CHECK(length(caption)<=4000), url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048), original_url TEXT NOT NULL CHECK(length(original_url) BETWEEN 1 AND 2048), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), author_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id), FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_revisions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), actor_user_id TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), caption TEXT NOT NULL CHECK(length(caption)<=4000), url TEXT NOT NULL CHECK(length(url) BETWEEN 1 AND 2048), original_url TEXT NOT NULL CHECK(length(original_url) BETWEEN 1 AND 2048), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,artifact_id,revision),
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, activity_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,artifact_id,activity_id),
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_revision_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, activity_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,artifact_id,revision,activity_id),
 FOREIGN KEY(installation_id,artifact_id,revision) REFERENCES documentation_artifact_revisions(installation_id,artifact_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_initiatives (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, initiative_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,artifact_id,initiative_id),
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,initiative_id) REFERENCES documentation_initiatives(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_revision_initiatives (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, initiative_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,artifact_id,revision,initiative_id),
 FOREIGN KEY(installation_id,artifact_id,revision) REFERENCES documentation_artifact_revisions(installation_id,artifact_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,initiative_id) REFERENCES documentation_initiatives(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_artifact_reviews (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, reviewed_revision INTEGER NOT NULL,
 reviewer_user_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('reviewed','rejected')), reviewed_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,artifact_id,revision), CHECK(revision=reviewed_revision+1),
 FOREIGN KEY(installation_id,artifact_id,revision) REFERENCES documentation_artifact_revisions(installation_id,artifact_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,artifact_id,reviewed_revision) REFERENCES documentation_artifact_revisions(installation_id,artifact_id,revision),
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
