-- Independent updater D1 only. A live execution retains the secret; store only its hash.
ALTER TABLE updater_execution_permits ADD COLUMN release_hash TEXT;
