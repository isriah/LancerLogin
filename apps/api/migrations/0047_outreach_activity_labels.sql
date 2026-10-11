CREATE TABLE hours_labels (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,id)
);
CREATE INDEX hours_label_catalog ON hours_labels(installation_id,archived,name,id);

CREATE TABLE hours_activity_labels (
  installation_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id,activity_id,label_id),
  FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,label_id) REFERENCES hours_labels(installation_id,id)
);
CREATE INDEX hours_activity_label_lookup ON hours_activity_labels(installation_id,label_id,activity_id);

INSERT INTO hours_labels(installation_id,id,name,archived,revision,created_at,updated_at)
  SELECT installation_id,id,name,archived,revision,created_at,updated_at FROM hours_categories;

INSERT INTO hours_activity_labels(installation_id,activity_id,label_id,created_at)
  SELECT installation_id,id,category_id,created_at FROM hours_activities;

DROP INDEX IF EXISTS hours_canonical_activity;
