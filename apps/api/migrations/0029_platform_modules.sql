CREATE TABLE platform_module_configuration (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK(hours_enabled IN (0,1)),
 documentation_enabled INTEGER NOT NULL DEFAULT 0 CHECK(documentation_enabled IN (0,1)),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 CHECK(documentation_enabled <= hours_enabled)
);
CREATE UNIQUE INDEX users_installation_identity ON users(installation_id,id);
CREATE TABLE platform_module_grants (
 installation_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 hours_manage INTEGER NOT NULL DEFAULT 0 CHECK(hours_manage IN (0,1)),
 documentation_manage INTEGER NOT NULL DEFAULT 0 CHECK(documentation_manage IN (0,1)),
 PRIMARY KEY(installation_id,user_id),
 FOREIGN KEY(installation_id,user_id) REFERENCES users(installation_id,id) ON DELETE CASCADE
);
