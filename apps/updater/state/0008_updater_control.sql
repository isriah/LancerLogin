-- Independent updater state only. Legacy admissions cannot acquire delegation.
ALTER TABLE updater_admissions ADD COLUMN actor_id TEXT;
CREATE TABLE updater_control_requests (
 installation_id TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 release_id INTEGER NOT NULL, release_identity TEXT NOT NULL, dashboard_origin TEXT NOT NULL,
 grant_hash TEXT, grant_expires INTEGER NOT NULL, session_hash TEXT, csrf TEXT, session_expires INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(installation_id,request_id)
);
CREATE UNIQUE INDEX updater_control_session ON updater_control_requests(session_hash);
CREATE TABLE updater_control_nonces (
 session_hash TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(session_hash,nonce)
);
