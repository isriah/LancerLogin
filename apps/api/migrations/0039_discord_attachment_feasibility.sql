-- Development-only synthetic transfer receipts; excluded from portable backups.
CREATE TABLE discord_attachment_proofs (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 id TEXT NOT NULL, member_id TEXT NOT NULL, discord_user_id TEXT NOT NULL,
 provider_iv TEXT NOT NULL, generation TEXT NOT NULL, google_iv TEXT NOT NULL,
 root_id TEXT NOT NULL, root_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('modal','processing','pending','saved','failed')),
 submit_id TEXT UNIQUE, expires_at INTEGER NOT NULL, busy_until INTEGER NOT NULL DEFAULT 0,
 file_id TEXT, mime TEXT, byte_size INTEGER, sha256 TEXT,
 PRIMARY KEY(installation_id,id)
);
CREATE TRIGGER discord_attachment_restore_guard BEFORE DELETE ON installations
WHEN EXISTS(SELECT 1 FROM discord_attachment_proofs WHERE installation_id=OLD.id AND (status='pending' OR busy_until>CAST(unixepoch('subsec')*1000 AS INTEGER)))
BEGIN SELECT RAISE(ABORT,'Synthetic attachment transfer is active; wait before recovery'); END;
