-- Transient admission state: excluded from logical application backups.
CREATE TABLE public_hour_admission_clock (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
 last_seen_ms INTEGER NOT NULL CHECK(last_seen_ms>=0)
);
CREATE TABLE public_hour_admission (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 policy TEXT NOT NULL, scope TEXT NOT NULL, subject_hash TEXT NOT NULL,
 window_start INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL, capacity INTEGER NOT NULL,
 PRIMARY KEY(installation_id,policy,scope,subject_hash,window_start),
 CONSTRAINT public_hour_admission_capacity CHECK(attempts BETWEEN 1 AND capacity),
 CHECK(expires_at>window_start AND capacity>0)
);
CREATE INDEX public_hour_admission_expiry ON public_hour_admission(installation_id,expires_at);
