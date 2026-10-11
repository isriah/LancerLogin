-- Active physical kiosks coexist. Distinct names keep device-specific health,
-- commands, and audit records unambiguous in the dashboard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_kiosks_active_name
ON kiosks(installation_id, lower(name))
WHERE active = 1;
