-- Maintenance is checked by frequent kiosk requests. Completed update history
-- must not increase the cost of detecting a recovery or deployment lock.
CREATE INDEX idx_web_update_maintenance
  ON web_update_requests(installation_id) WHERE maintenance = 1;

-- Walk only the next bounded fingerprint page, rather than sorting every
-- enrollment or starting from the complete active roster.
CREATE INDEX idx_fingerprint_vault_manifest
  ON kiosk_fingerprint_vault_templates(installation_id, vault_id, fingerprint_id, member_id, enrollment_id);
