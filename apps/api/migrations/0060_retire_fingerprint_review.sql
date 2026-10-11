-- Legacy biometric identity review is retired. Keep only revoked grant IDs so
-- an old approval cannot be replayed as a new enrollment with fields stripped.
-- This operational state is not portable and contains no roster or slot data.
CREATE TABLE kiosk_fingerprint_retired_review_grants (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL CHECK(length(grant_id) BETWEEN 1 AND 128),
  PRIMARY KEY(installation_id,grant_id)
);
INSERT INTO kiosk_fingerprint_retired_review_grants(installation_id,grant_id)
SELECT h.installation_id,s.grant_id FROM kiosk_fingerprint_review_slots s
JOIN kiosk_fingerprint_review_manifests h ON h.id=s.manifest_id
WHERE s.grant_id IS NOT NULL;

-- Retire only review-derived sources. Independent fresh enrollments, vault
-- configuration, pending resets, roster, attendance and pairings stay intact.
DELETE FROM kiosk_fingerprint_vault_templates
WHERE EXISTS(SELECT 1 FROM kiosk_fingerprint_retired_review_grants r
  WHERE r.installation_id=kiosk_fingerprint_vault_templates.installation_id
    AND r.grant_id=kiosk_fingerprint_vault_templates.enrollment_id);
DELETE FROM kiosk_fingerprint_review_manifests;
DELETE FROM kiosk_fingerprint_review_requests;

CREATE TRIGGER fingerprint_vault_retired_review BEFORE INSERT ON kiosk_fingerprint_vault_templates
WHEN EXISTS(SELECT 1 FROM kiosk_fingerprint_retired_review_grants r
  WHERE r.installation_id=NEW.installation_id AND r.grant_id=NEW.enrollment_id)
BEGIN SELECT RAISE(ABORT,'fingerprint enrollment authority retired'); END;

-- Historical tables remain for immutable migration and cleanup compatibility,
-- but no older runtime may recreate review authority after this upgrade.
CREATE TRIGGER fingerprint_review_request_retired BEFORE INSERT ON kiosk_fingerprint_review_requests
BEGIN SELECT RAISE(ABORT,'fingerprint identity review retired'); END;
CREATE TRIGGER fingerprint_review_manifest_retired BEFORE INSERT ON kiosk_fingerprint_review_manifests
BEGIN SELECT RAISE(ABORT,'fingerprint identity review retired'); END;
CREATE TRIGGER fingerprint_review_slot_retired BEFORE INSERT ON kiosk_fingerprint_review_slots
BEGIN SELECT RAISE(ABORT,'fingerprint identity review retired'); END;
