-- Active-name uniqueness supersedes the historical one-active-device limit.
-- Existing devices, credentials, pairing identities and attendance are retained.
DROP INDEX IF EXISTS idx_one_active_kiosk;
