CREATE TABLE documentation_initiatives (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 narrative TEXT NOT NULL CHECK(length(narrative)<=8000), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), author_user_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id),
 FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_initiative_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 initiative_id TEXT NOT NULL, activity_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,initiative_id,activity_id),
 FOREIGN KEY(installation_id,initiative_id) REFERENCES documentation_initiatives(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_initiative_revisions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 initiative_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), actor_user_id TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), narrative TEXT NOT NULL CHECK(length(narrative)<=8000),
 archived INTEGER NOT NULL CHECK(archived IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,initiative_id,revision),
 FOREIGN KEY(installation_id,initiative_id) REFERENCES documentation_initiatives(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_initiative_revision_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 initiative_id TEXT NOT NULL, revision INTEGER NOT NULL, activity_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,initiative_id,revision,activity_id),
 FOREIGN KEY(installation_id,initiative_id,revision) REFERENCES documentation_initiative_revisions(installation_id,initiative_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
