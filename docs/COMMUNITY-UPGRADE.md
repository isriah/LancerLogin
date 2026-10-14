# Upgrade Community to Modular

The direct path is an in-place upgrade through the v1.2.6 Community bridge. Install that stable bridge on the dashboard and each physical kiosk, review the private controller, then opt in to Beta in Settings → Updates. Only a complete published official release is an update target, never a private build or source branch. Follow [Stable and Beta update tracks](UPDATE-TRACKS.md) before preparing Modular.

Update the web software first, then each kiosk. Do not create a replacement database, re-image a working kiosk, clear its reader, or import a portable backup as the normal upgrade procedure.

## What carries over

| Existing Community content | In-place Modular result |
| --- | --- |
| Roster IDs, names, contacts and active/inactive state | Retained with the same identities. |
| Member labels, dated label changes and attendance rules | Retained, including historical policies. |
| Meetings, templates, attendance, corrections and delivery history | Retained without converting Attendance data into another module's data. |
| Branding, time zone and attendance settings | Retained. Fingerprint authentication remains the default. |
| Admin and Operator accounts and password hashes | Retained. Existing Operators receive Attendance management access; optional-module permissions are assigned separately. |
| Saved reports, pinned report tabs and walkthrough progress | Retained. Completed Community walkthroughs do not need to be repeated. |
| Provider settings and encrypted grants | Retained with the existing encryption key and installation configuration. Verify provider health afterward. |
| Existing kiosk identities, names and pairing credentials | Retained. Each additional kiosk needs its own pairing. |
| Kiosk-local mappings, reader templates, PIN and pending scans | Preserved by an in-place kiosk update. These are not contained in a dashboard backup. |
| Module availability | Attendance stays enabled and ready. Outreach and Carpool start disabled, with no retention countdown. Peer fingerprint sync and separate cloud storage start off. |

A roster export alone cannot identify fingerprints in reader slots. Keep the original slot-to-member mappings with the original reader. Do not guess missing mappings or overwrite occupied slots.

## Before updating

1. Review the compatible official release and its notes. Update the existing private controller to its reviewed channel-aware version while retaining exact resource identities, credentials and production approval rules.
2. Download an entire-installation backup through **Settings → Updates**, save it securely outside the installation, and confirm that the file was saved.
3. Preserve the existing D1 database name and UUID, `SESSION_KEY`, `INTEGRATION_KEY`, provider credentials, dashboard origin and deployment configuration in secure storage. Never put their values in source control, logs or support tickets.
4. Preserve each kiosk's protected local state through an authorized secure backup procedure. Include pairing, mappings, local credential secrets, PIN, roster cache, pending scans and retained outcomes. Fingerprints remain in the R503 unless optional peer sync or cloud storage is explicitly enabled. Preserve the separate 32-byte `FINGERPRINT_VAULT_KEY` independently if cloud storage has been configured; the integration key cannot decrypt that vault.
5. Note roster counts, a known member ID, recent attendance, a saved report, kiosk names and pending-scan counts for comparison. Use a quiet period, but do not discard queued scans to make the counts zero.

## Update and verify the web installation

1. Follow [Web updates](WEB-UPDATES.md), updating the existing installation rather than running fresh provisioning. Kiosks retain scans locally while update maintenance pauses attendance writes.
2. Wait for verified completion, then reload the dashboard. A successful workflow alone is insufficient. Stop if recovery is required or Worker and dashboard versions disagree.
3. Use an existing Admin account to check roster identities, inactive members, labels and rules, branding, time zone, meetings, attendance history, reports and integrations.
4. Confirm Attendance is enabled and ready in **Modules** and that an existing Operator retains Attendance access. Leave optional modules disabled until their setup and permissions have been reviewed.
5. Check **Kiosks** still lists the original devices and their health. Do not re-pair a retained device to resolve an unconfirmed update.

## Update and verify each kiosk

1. Follow [Update a physical kiosk](KIOSK.md#update-a-physical-kiosk), one existing kiosk at a time. Keep its SD card, reader, pairing and local state.
2. Wait for it to return online. Confirm its installed version and reader/input health.
3. Allow pending scans to replay. Check their original timestamps and falling pending counts. Review rejected scans rather than blindly resubmitting or restoring an old queue.
4. For the fingerprint upgrade path, re-enroll members through PIN-protected **Authentication maintenance** while the kiosk is online. To start over, back up protected local state, use **Kiosks → Fingerprint re-enrollment → Reset all fingerprint mappings**, and wait for every active kiosk to acknowledge before enrolling. This explicit reset disables sharing and clears fingerprint associations, not reader templates, queues, pairing or badge/QR mappings. Replace only known occupied slots deliberately; never guess an unknown slot.
5. During an appropriate test meeting, scan a freshly enrolled member. Confirm the correct member and attendance outcome in the dashboard, then pair additional kiosks and test them independently. Enable peer fingerprint sync only with organizational permission and mutually approved device identities. Peer sync shares eligible new enrollments; it is not a bulk migration of existing reader slots.

### Optional durable cloud provisioning

An Admin may separately enable **Fingerprint cloud storage** after reviewing its consent and security boundary. The server manages a separate encryption key and can decrypt these durable copies for authorized paired kiosks. This is not peer-only end-to-end encryption. Once verified fingerprints have uploaded, new kiosks can receive them even while all previous kiosks are offline.

The upgrade preserves existing local mappings and reader contents without automatically blessing their biometric associations. New online enrollments and imported cloud copies retain an immutable roster ID. Older mappings without that identity, including retained Community mappings and enrollments made offline, require re-enrollment before sharing. Legacy review approvals are retired, not a migration path. Updating software alone does not clear reader contents or mappings; reset is an explicit Admin action. A current external-ID match alone is not proof of the original person. Unknown slots cannot be recovered from a roster backup and are never automatically exported or overwritten. See [Kiosk cloud provisioning](KIOSK.md#provision-new-kiosks-from-encrypted-cloud-copies).

Cloud disablement deletes live cloud templates but not reader copies. Member deactivation or ID change deletes that member's live cloud templates; retiring an originating kiosk does not erase otherwise valid enrollments. Preserve the original vault key for infrastructure recovery, and do not rotate it to bypass a decryption failure. Review every reader when withdrawing access; there is no remote destructive wipe.

## Optional modules and recovery

Enable Outreach or Carpool deliberately through **Modules**, complete its setup, and assign its Operator permissions. Attendance workflows remain separate. Verify optional integrations before enabling their live operations.

A portable installation restore is a recovery or replacement workflow, not the in-place upgrade path. It intentionally revokes kiosk and pairing authority and disables peer fingerprint sync and cloud storage. Vault templates and authority are not portable and are cleared by restore. It does not restore Pi-local mappings, secrets, queues or reader contents. See [Backup and restore](BACKUP-RESTORE.md) before choosing that path.

If verification fails, preserve current state and follow approved recovery. Do not automatically roll back code, restore D1, restore an old queue, rotate secrets or re-pair kiosks. Review backward code changes against the forward-migrated schema first.

## Verification limits

Local synthetic rehearsals cover Community v1.2.4, v1.2.5 and the v1.2.6 bridge migration boundaries. They compare every existing application table and column before and after migration, including inactive members, labels, policies, corrections, settings, reports, provider grants, retained kiosk credentials and update-track consent. Separate software tests cover retained local kiosk state and queued-event replay.

These checks do not prove an individual installation's backups, provider permissions, resource identities or hardware. Complete its post-update checks above. Publication, release and deployment remain separate from candidate verification.
