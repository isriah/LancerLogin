CREATE TABLE documentation_definitions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, title TEXT NOT NULL, definition TEXT NOT NULL, source TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), author_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id), FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_definition_revisions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, definition_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), actor_user_id TEXT NOT NULL, title TEXT NOT NULL, definition TEXT NOT NULL, source TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,definition_id,revision), FOREIGN KEY(installation_id,definition_id) REFERENCES documentation_definitions(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claims (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, id TEXT NOT NULL, title TEXT NOT NULL, definition_id TEXT NOT NULL, definition_revision INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, rationale TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), author_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id), FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(installation_id,definition_id,definition_revision) REFERENCES documentation_definition_revisions(installation_id,definition_id,revision) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claim_revisions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), actor_user_id TEXT NOT NULL, title TEXT NOT NULL, definition_id TEXT NOT NULL, definition_revision INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, rationale TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)), review_decision TEXT CHECK(review_decision IN ('reviewed','rejected')), reviewed_revision INTEGER, reviewer_user_id TEXT, reviewed_at TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,claim_id,revision), FOREIGN KEY(installation_id,claim_id) REFERENCES documentation_claims(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(installation_id,definition_id,definition_revision) REFERENCES documentation_definition_revisions(installation_id,definition_id,revision) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claim_revision_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), activity_id TEXT NOT NULL, target_revision INTEGER NOT NULL CHECK(target_revision>=0),
 PRIMARY KEY(installation_id,claim_id,revision,activity_id), FOREIGN KEY(installation_id,claim_id,revision) REFERENCES documentation_claim_revisions(installation_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claim_revision_teams (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), team_id TEXT NOT NULL, target_revision INTEGER NOT NULL CHECK(target_revision>=0),
 PRIMARY KEY(installation_id,claim_id,revision,team_id), FOREIGN KEY(installation_id,claim_id,revision) REFERENCES documentation_claim_revisions(installation_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,team_id) REFERENCES hours_teams(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claim_revision_initiatives (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), initiative_id TEXT NOT NULL, target_revision INTEGER NOT NULL CHECK(target_revision>=0),
 PRIMARY KEY(installation_id,claim_id,revision,initiative_id), FOREIGN KEY(installation_id,claim_id,revision) REFERENCES documentation_claim_revisions(installation_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,initiative_id) REFERENCES documentation_initiatives(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claim_revision_artifacts (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), artifact_id TEXT NOT NULL, target_revision INTEGER NOT NULL CHECK(target_revision>=0),
 PRIMARY KEY(installation_id,claim_id,revision,artifact_id), FOREIGN KEY(installation_id,claim_id,revision) REFERENCES documentation_claim_revisions(installation_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,artifact_id) REFERENCES documentation_artifacts(installation_id,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(installation_id,artifact_id,target_revision) REFERENCES documentation_artifact_revisions(installation_id,artifact_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claim_revision_metrics (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), metric_id TEXT NOT NULL, target_revision INTEGER NOT NULL CHECK(target_revision>=0),
 PRIMARY KEY(installation_id,claim_id,revision,metric_id), FOREIGN KEY(installation_id,claim_id,revision) REFERENCES documentation_claim_revisions(installation_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,metric_id) REFERENCES documentation_metrics(installation_id,id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(installation_id,metric_id,target_revision) REFERENCES documentation_metric_revisions(installation_id,metric_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_claim_reviews (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, revision INTEGER NOT NULL, reviewed_revision INTEGER NOT NULL, reviewer_user_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('reviewed','rejected')), reviewed_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,claim_id,revision), CHECK(revision=reviewed_revision+1),
 FOREIGN KEY(installation_id,claim_id,revision) REFERENCES documentation_claim_revisions(installation_id,claim_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,claim_id,reviewed_revision) REFERENCES documentation_claim_revisions(installation_id,claim_id,revision) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(installation_id,reviewer_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
