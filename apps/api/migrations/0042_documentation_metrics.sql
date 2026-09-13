CREATE TABLE documentation_metrics (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), kind TEXT NOT NULL CHECK(kind IN ('person-hours','participants','interactions','reach','outcomes','other')), value TEXT NOT NULL CHECK(typeof(value)='text' AND length(value) BETWEEN 1 AND 23), unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 80), period_start TEXT NOT NULL, period_end TEXT NOT NULL CHECK(period_end>=period_start), source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 2000), method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 4000), basis TEXT NOT NULL CHECK(basis IN ('measured','estimated')), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), author_user_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,id), FOREIGN KEY(installation_id,author_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_metric_revisions (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 metric_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), actor_user_id TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), kind TEXT NOT NULL CHECK(kind IN ('person-hours','participants','interactions','reach','outcomes','other')), value TEXT NOT NULL CHECK(typeof(value)='text' AND length(value) BETWEEN 1 AND 23), unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 80), period_start TEXT NOT NULL, period_end TEXT NOT NULL CHECK(period_end>=period_start), source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 2000), method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 4000), basis TEXT NOT NULL CHECK(basis IN ('measured','estimated')), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,metric_id,revision),
 FOREIGN KEY(installation_id,metric_id) REFERENCES documentation_metrics(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_metric_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 metric_id TEXT NOT NULL, activity_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,metric_id,activity_id),
 FOREIGN KEY(installation_id,metric_id) REFERENCES documentation_metrics(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_metric_revision_activities (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 metric_id TEXT NOT NULL, revision INTEGER NOT NULL, activity_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,metric_id,revision,activity_id),
 FOREIGN KEY(installation_id,metric_id,revision) REFERENCES documentation_metric_revisions(installation_id,metric_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_metric_initiatives (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 metric_id TEXT NOT NULL, initiative_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,metric_id,initiative_id),
 FOREIGN KEY(installation_id,metric_id) REFERENCES documentation_metrics(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,initiative_id) REFERENCES documentation_initiatives(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE documentation_metric_revision_initiatives (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 metric_id TEXT NOT NULL, revision INTEGER NOT NULL, initiative_id TEXT NOT NULL,
 PRIMARY KEY(installation_id,metric_id,revision,initiative_id),
 FOREIGN KEY(installation_id,metric_id,revision) REFERENCES documentation_metric_revisions(installation_id,metric_id,revision) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,initiative_id) REFERENCES documentation_initiatives(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
