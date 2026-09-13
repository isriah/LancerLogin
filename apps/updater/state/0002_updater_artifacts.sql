-- Independent updater-state D1 only; never application D1 or its backup.
CREATE TABLE updater_artifacts (
  installation_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16777216),
  chunk_count INTEGER NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1)),
  PRIMARY KEY(installation_id, artifact_id)
);
CREATE TABLE updater_artifact_chunks (
  installation_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  PRIMARY KEY(installation_id, artifact_id, chunk_index),
  FOREIGN KEY(installation_id, artifact_id) REFERENCES updater_artifacts(installation_id, artifact_id)
);
CREATE TABLE updater_provider_operations (
  installation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  PRIMARY KEY(installation_id, operation_id)
);
