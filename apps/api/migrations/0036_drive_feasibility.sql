-- P0 feasibility state only. Not a Documentation inventory or portable backup.
CREATE TABLE google_drive_feasibility (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0,
 project_number TEXT NOT NULL, browser_key TEXT NOT NULL,
 root_id TEXT, root_name TEXT, generation TEXT NOT NULL
);
CREATE TABLE google_picker_intents (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, state_hash TEXT NOT NULL UNIQUE,
 actor_user_id TEXT NOT NULL, session_hash TEXT NOT NULL,
 generation TEXT NOT NULL, connection_revision INTEGER NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('root','source')),
 status TEXT NOT NULL CHECK(status IN ('pending','exchanging','ready','claimed','selected')),
 expires_at INTEGER NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL,
 PRIMARY KEY(installation_id,id),
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) ON DELETE CASCADE
);
CREATE TABLE google_drive_proof_runs (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, actor_user_id TEXT NOT NULL, generation TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
 ciphertext TEXT NOT NULL, iv TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,id),
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) ON DELETE CASCADE
);
