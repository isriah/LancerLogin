# Upgrade Community to Modular

This guide is for a LancerLogin 1 (Community) installation moving to LancerLogin 2 (Modular). The direct path is an in-place upgrade through the v1.2.6 Community bridge. Install that stable bridge on the dashboard and each physical kiosk, review the private controller, then prepare the LancerLogin 2 release in **Settings > Updates** on the track that offers it (Beta for a beta release, Stable once a stable release is published). Only a complete published official release is an update target, never a private build or source branch. Follow [Stable and Beta update tracks](UPDATE-TRACKS.md#upgrading-from-lancerlogin-1) before preparing LancerLogin 2. The everyday update steps are in [Update LancerLogin](https://isriah.github.io/LancerLogin/updates.html).

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
| Module availability | Attendance stays enabled and ready. Outreach starts disabled, with no retention countdown; it is an official plugin included by default. Carpool is a separately selected plugin and is available only in builds that include it, where it also starts disabled. Peer fingerprint sync and separate cloud storage start off. |

A roster export alone cannot identify fingerprints in reader slots. Keep the original slot-to-member mappings with the original reader. Do not guess missing mappings or overwrite occupied slots.

## Before updating

1. Review the compatible official release and its notes. Update the existing private controller to its reviewed channel-aware version while retaining exact resource identities, credentials and production approval rules.
2. Download an entire-installation backup through **Settings > Updates**, save it securely outside the installation, and confirm that the file was saved.
3. Preserve the existing D1 database name and UUID, `SESSION_KEY`, `INTEGRATION_KEY`, provider credentials, dashboard origin and deployment configuration in secure storage. Never put their values in source control, logs or support tickets.
4. Preserve each kiosk's protected local state through an authorized secure backup procedure. Include pairing, mappings, local credential secrets, PIN, roster cache, pending scans and retained outcomes. Fingerprints remain in the R503 unless optional cloud storage is explicitly enabled. Preserve the separate 32-byte `FINGERPRINT_VAULT_KEY` independently if cloud storage has been configured; the integration key cannot decrypt that vault.
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
4. For the fingerprint upgrade path, re-enroll members through PIN-protected **Authentication maintenance** while the kiosk is online. To start over, back up protected local state, use **Reset all fingerprint mappings** in **Settings > Modules > Attendance > Fingerprint recovery**, and wait for every active kiosk to acknowledge before enrolling. This explicit reset disables sharing and clears fingerprint associations, not reader templates, queues, pairing or badge/QR mappings. Replace only known occupied slots deliberately; never guess an unknown slot.
5. During an appropriate test meeting, scan a freshly enrolled member. Confirm the correct member and attendance outcome in the dashboard, then pair additional kiosks and test them independently. Enable cloud fingerprint storage only with organizational permission. Historical unverified reader slots are not automatically shared.

### Optional fingerprint cloud storage

The upgrade preserves existing local mappings and reader contents without treating their biometric associations as verified. Retained Community mappings and enrollments made offline lack an immutable roster identity, so they require re-enrollment before they can be shared through **Fingerprint cloud storage**. Updating software alone does not clear reader contents or mappings. Unknown slots cannot be recovered from a roster backup and are never automatically exported or overwritten. Enable cloud storage only with organizational permission; its boundary is described in [privacy](PRIVACY.md#optional-fingerprint-cloud-storage) and its kiosk behavior in the [kiosk reference](KIOSK.md#fingerprint-cloud-storage-on-kiosks).

## Optional modules and recovery

Enable Outreach, or Carpool when its plugin is included, deliberately through **Modules**, complete its setup, and assign its Operator permissions. Attendance workflows remain separate. Verify optional integrations before enabling their live operations.

A portable installation restore is a recovery or replacement workflow, not the in-place upgrade path. It intentionally revokes kiosk and pairing authority and disables fingerprint cloud storage. Vault templates and authority are not portable and are cleared by restore. It does not restore Pi-local mappings, secrets, queues or reader contents. See [Backup and restore](BACKUP-RESTORE.md) before choosing that path.

If verification fails, preserve current state and follow approved recovery. Do not automatically roll back code, restore D1, restore an old queue, rotate secrets or re-pair kiosks. Review backward code changes against the forward-migrated schema first.

## What the release checks cover

Each release's migrations are rehearsed against synthetic Community v1.2.4, v1.2.5 and v1.2.6 databases, comparing every existing application table and column before and after migration. These checks cannot see an individual installation's backups, provider permissions, resource identities or hardware, so complete the post-update checks above on your own installation.
