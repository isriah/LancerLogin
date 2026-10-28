# Privacy notice

LancerLogin stores organization configuration, roster, meeting, attendance, audit, and optional integration information in the adopter's Cloudflare account until an Administrator exports or deletes it. The organization operating an installation is responsible for its own retention and access decisions.

## Kiosk identity and attendance data

Retained rejected scans also synchronize to the kiosk's existing paired installation for Administrator review. This includes member and event IDs, recorded time, rejection reason, optional meeting/pairing references, and clock-verification evidence. It does not include biometric data or raw credentials. The kiosk keeps its original protected records until the dashboard has acknowledged them, then removes them locally after 30 days (or earlier, oldest first, beyond 1,000 acknowledged records); dashboard review adds an audit entry and synchronizes reviewed status back to the device. Recorded device time can be unverified and is not silently converted into attendance.

Fingerprint templates remain in the attached R503 sensor by default. Optional cloud storage changes this boundary as described below. LancerLogin does not capture or upload raw fingerprint images. RFID, NFC, and QR values are transformed by HMAC-SHA256 with a kiosk-local owner-only secret; only the keyed digest and member mapping are retained locally. Raw badge and QR values, local digests, and the transform secret are not sent to the Worker, stored in D1, logged, placed in fixtures, or included in portable dashboard backups.

Member ID entry is checked against an owner-only local active-roster cache. Badge and QR mappings also require the mapped member to remain active. The kiosk sends only the resolved member ID and operational attendance fields through the existing queue. Local queued attendance events are retained until they can be delivered or handled through the documented recovery process.

Server-side retirement or Attendance disablement does not remotely erase local mappings or sensor templates. Authorized staff must use the kiosk's PIN-protected **Authentication maintenance** page to remove local mappings before a device is repurposed or decommissioned.

Unpairing archives the previous installation's local state (credential, roster cache, mappings, attendance history and fingerprint sharing state) in owner-only storage on the kiosk. The kiosk deletes those archives when it is paired again and 30 days after unpairing. Reader templates are not part of the archive and stay on the sensor. File deletion on flash storage does not guarantee physical erasure of the card.

### Retired peer fingerprint sharing

Cloud storage is the only supported fingerprint synchronization path. Peer enablement, approval, registration and transfer endpoints are retired. Older clients receive disabled peer metadata; transfer requests are rejected. Upgrading does not enable cloud storage automatically or delete reader templates, local mappings, historical keys, encrypted outboxes or import journals. Preserve this protected historical state for recovery. Previously retained relay ciphertext and backups are not erased by this software change; any historical cleanup requires a separately reviewed procedure.

## Optional fingerprint cloud storage

Cloud storage is separately Admin-controlled and off by default. Enabling it authorizes the installation server to store encrypted fingerprint templates and automatically provision currently authorized paired R503 kiosks, including new kiosks while every previous kiosk is offline. Obtain the organization's permission for this biometric storage before enabling it. There is no peer approval step; peer transfer is retired.

The server manages a separate encryption secret and can decrypt these templates. It receives plaintext briefly over authenticated HTTPS and retains only authenticated ciphertext in D1. This is not end-to-end private from the server. The server also sees immutable member associations, source device/pairing, enrollment identity, keyed content digest and timestamps. No template route is available to dashboard browsers. Plaintext is not intentionally persisted in Pi files, D1, logs, fixtures or portable backups, but compromised servers or kiosks and memory dumps can expose it.

New online enrollments and cloud-imported copies carry immutable roster identity in protected local mappings. Backfill reads only occupied slots whose persisted identity matches a fresh active roster. Older or offline mappings without that binding require re-enrollment before sharing; unknown slots are untouched. Legacy review approvals are retired and cannot authorize template uploads or downloads. Automatic receiving checks the same immutable identity and never overwrites an occupied slot. Only a byte-identical same-member copy can be reused.

Cloud templates have no seven-day expiry. A verified template remains associated with its active immutable member until that member is deactivated or their external ID changes, cloud storage is disabled, Attendance is disabled, or the installation is restored. Up to 20 distinct templates per member and 20,000 per installation are accepted; capacity failure does not replace old records. Retiring the source kiosk does not erase valid enrollment data. Removing a mapping or replacing a finger locally does not delete older cloud fingerprints or copies on other readers. Deactivate the member or disable cloud storage when withdrawing the retained cloud authorization, and review every affected reader. This is not remote erasure.

Portable backups exclude vault enablement, identity, ciphertext and keys. Entire-installation restore clears cloud authority and leaves storage off; enabling it again requires renewed consent and valid fresh enrollment identities. Raw infrastructure exports may retain ciphertext after live deletion. Protect the separate key independently, and do not combine data/key backups casually. Owner-only kiosk journals retain slot/member/retry metadata, not plaintext templates. See [backup and restore](BACKUP-RESTORE.md).

## Fingerprint re-enrollment and reset

Members re-enroll through the kiosk's PIN-protected Authentication maintenance page after upgrading. There is no legacy identity-review workflow and no member-ID lookup that can approve an existing fingerprint. Review-derived cloud copies are revoked; independent fresh enrollments remain. A small nonportable denylist retains retired approval identifiers to prevent their reuse as new enrollment authority. Historical infrastructure and protected kiosk backups may still contain retired review metadata; protect it and do not restore it as active authority.

Resetting all fingerprint mappings deletes live cloud copies, disables sharing, and requests removal of fingerprint member-to-slot associations on all currently active paired kiosks. It retains reader templates and unrelated roster, attendance, pairing and authentication data. Offline devices retain their old associations until reconnect and acknowledgement. The dashboard lists this pending state. Reset is not remote sensor erasure and does not remove copies from historical backups.

## Dashboard and integrations

To slow password and setup-code guessing, local sign-in, first-Admin setup and kiosk pairing count attempts per client network address. D1 stores only a keyed hash of the route and address, a window start and a count, never the address itself, and the scheduled pass deletes these rows after a day.

### Public Outreach forms

Members can enter a roster ID to submit participation or ask Staff to review an activity. These forms do not authenticate the member; Staff should treat identity as self-asserted. Correction requests do not expose a member's submission history or alter counted hours without an audited Staff decision.

Public member-ID validation defaults to **Off**. An Admin can instead enable **Validate ID only** or **Validate ID and show name** in Outreach settings. Both enabled modes reveal whether an entered ID belongs to an active member; the name mode additionally reveals that member's name. Use either only when appropriate for the audience and the organization's privacy requirements.

Validation uses a bounded, exact server lookup after leaving the ID field. No roster or valid-ID list is downloaded to the public browser. Off returns no validation result, and ID-only responses contain no name. The server rechecks privacy mode and module authority before returning the result. Responses are noncacheable and the form does not save lookup results in browser storage or log member information. Previously disclosed information cannot be withdrawn from someone who already saw or recorded it.

The installation allows up to 60 public ID checks per minute across all visitors. The temporary limiter stores only an installation identifier, minute window, and count, not entered IDs or network addresses. When the limit or network prevents checking, the form does not label the ID invalid; submissions can still be verified normally. Throttling reduces casual enumeration but is not proof against a determined visitor. Disabling live checks does not turn the public submission form into member authentication.

The dashboard stores local-password hashes, encrypted optional-integration credentials, roster and attendance records, and audit history. Saved integration values are not displayed in the browser. An entire-installation backup can contain password hashes, encrypted integration ciphertext, kiosk credential hashes, and audit history. Protect it like an Administrator credential.

## Community telemetry retirement

Community reporting is disabled. LancerLogin does not collect or transmit Community telemetry. Older consent inputs are ignored. Historical telemetry fields remain inert to preserve migration and backup compatibility. General attendance, backup, and security data stays within the installation.
