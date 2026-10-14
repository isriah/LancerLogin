# Data backup and restore

This guide is for Administrators. Back up before a web update, bulk deletion, or recovery decision. A backup is sensitive: it can contain attendance information, password hashes, encrypted integration values, kiosk credential hashes, and audit history.

## Dashboard backups

Open **Settings → Data**. Each category has separate download, restore, and typed-confirmation deletion controls.

| Category | Includes | Important boundary |
| --- | --- | --- |
| Meetings and attendance | Meetings, audience label selections, scans, corrections, excuses, and contests | Deletion keeps roster, member labels, accounts, settings, integrations, and audit history. |
| Roster | Member identity/contact data, Discord links, active state, dated label changes, label definitions, attendance rules, the recent compliance window, and policy activation date | Dashboard accounts remain separate. Historical members missing from a restore remain inactive when referenced. |
| Entire installation | Portable retained D1 state, including saved personal/shared reports, account-pinned report tabs, and Discord label-to-role associations | Restore only while the installation encryption secrets are unchanged. Operational role sync jobs and fingerprint relay state are not replayed from dashboard backups. |

Each JSON file records its scope and schema version. The dashboard rejects a file from another category and requires `RESTORE <CATEGORY>` exactly. Dashboard restore accepts files up to 10 MiB. **Reset onboarding** only reopens the shared Guided Setup checklist; it does not delete organization data.

Backup schema 21 adds each account's page walkthrough progress and dismissal preference to entire-installation backups. Backups before schema 21 restore with no recorded walkthrough progress. Roster and meetings restores preserve walkthrough progress, and resetting Guided Setup does not change it.

The earlier Community-based Modular schema 22 adds optional-module lifecycle and Operator assignment authority to entire-installation backups. Public Community v1.2.5 independently uses schema 22 for Discord delivery batches. The importer distinguishes the complete Community table manifest without Modular metadata from the Modular format; the number alone is not sufficient. Restoring a supported Community backup enables Attendance, completes module selection, and assigns Attendance to every restored Operator so existing access is preserved.

Backup schema 23 adds Attendance setup progress and retained-data cleanup state. Restoring an older supported backup upgrades Attendance setup records without reopening setup for an existing Community installation. Cleanup leases are transient authority and are deliberately not portable.

Backup schema 24 adds each Admin's developer-control visibility preference. Durable scheduler state remains runtime authority outside portable backups, so restore cannot start background work or replay elapsed scheduler passes.

Backup schema 25 adds Outreach participation data. Schema 26 adds correction and reopen records. Schema 27 adds reviewed publication state and provider-operation history.

Backup schema 28 introduces the `lancerlogin-community-modular` envelope. It records the Core and optional-module ownership contract for every included table. Schemas 31 and 32 require an exact ownership match and reject undeclared tables or columns. Released Community backups through schema 22 and supported earlier Community-based Modular archives use explicit adapters. Backups produced by incompatible Modular prototypes are rejected instead of being guessed into the Community data model.

Backup schema 30 adds Carpool-owned plans, participants, assignments, import profiles, and location cache records to entire-installation backups. Supported schema 30 and 31 backups retain those records in the current format. Earlier supported backups restore with Carpool disabled and empty.

Backup schema 32 preserves Discord delivery batch identifiers introduced in Community v1.2.5. Older supported archives default these identifiers to null. This does not resume provider work during restore; the existing review and credential-revocation safeguards still apply.

Backup schema 33 adds the Outreach public member-ID validation setting and activity associations on correction requests. Earlier supported backups restore live validation as **Off**. Current backups preserve the selected privacy mode, so review it before making a restored public form available to a new audience. Lookup throttling is temporary operational state, excluded from portable backups. Event-level corrections retain their associated activity and require Staff to select the affected entry before changing counted participation.

Backup schema 35 adds Carpool planning defaults. Earlier supported backups use the standard 4-mile preferred and 12-mile maximum radii for new plans. Saved Geoapify credentials are excluded from portable backups and removed during entire-installation restore. Configure location lookup again after recovery. Existing Carpool plans retain their own distances.

Backup schema 36 preserves the event details queued for each Outreach publication destination. Earlier supported backups default those snapshots to null and retain their existing publication timing. Restored pending operations remain paused until Staff explicitly retries; a restore does not publish or remove provider events. Invalid snapshot identities, times or all-day dates are rejected before restoration.

Backup schema 31 adds the installation's configured kiosk authentication method. Earlier supported backups restore it as fingerprint, preserving the prior behavior. The method reported by each physical kiosk is operational state and is not portable. Fingerprint templates, slot mappings, badge and QR mappings, local credential transform secrets, local active-roster caches, and pending kiosk events are not included in dashboard backups. Portable restore still revokes every kiosk credential, so re-pair each device and review its owner-only local state before returning it to service.

Fingerprint sync configuration, its installation identity, public device key registrations, and encrypted deliveries are non-portable operational state. Entire-installation restore removes that authority and leaves sync disabled. It does not restore Pi private keys, approved peers, outboxes, or receiver journals. After re-pairing, old local sync state must be reviewed because it is bound to the previous installation identity and pairing. Do not delete that state to bypass a mismatch or copy it to another kiosk. Preserve it securely and use a reviewed recovery procedure; reader templates remain intact.

Optional fingerprint cloud storage is also operational and non-portable. Dashboard exports exclude `kiosk_fingerprint_vault_settings` and `kiosk_fingerprint_vault_templates`. Entire-installation restore removes both authority and ciphertext and leaves storage off. The separate `FINGERPRINT_VAULT_KEY` is a Worker secret, not a dashboard backup field. Preserve it independently for infrastructure recovery; replacing a missing key cannot decrypt existing ciphertext. Cloud storage can be disabled without that key to delete its live cloud copies, but deletion is not recovery and does not erase reader copies or historical infrastructure backups. Before re-enabling after restore, review local immutable roster associations and renewed biometric consent.

Fingerprint reset batches, per-pair reset commands and retired review-grant identifiers are non-portable operational state. Historical review tables remain for migration compatibility, but their requests, proofs and grants are no longer active authority. Dashboard backups exclude `kiosk_fingerprint_review_requests`, `kiosk_fingerprint_review_manifests`, `kiosk_fingerprint_review_slots`, `kiosk_fingerprint_reset_batches`, `kiosk_fingerprint_reset_commands` and `kiosk_fingerprint_retired_review_grants`; entire-installation restore clears operational authority. Raw D1 exports and older owner-only Pi backups may retain sensitive retired member/slot/proof metadata and private review keys. Protect those backups separately and never reuse them to authorize sharing. Current owner-only reset journals retain pending intents and reset tombstones. Do not bypass a pairing, storage-generation or pending-reset mismatch. A mappings-only reset retains reader templates and cannot remove old associations from an offline device until it reconnects and acknowledges.

Schema 20 added saved report views and report-tab preferences to entire-installation backups. Older backups restore with an empty report library. Roster and meetings restores preserve existing reports. If a preserved report refers to a label that is absent after a category restore, the report displays an actionable warning and keeps the missing reference for editing instead of broadening its results.

Portable roster backups omit Discord role IDs. Restoring a roster keeps only existing role associations whose labels remain active, and stops any pending role sync. It does not modify Discord roles.

If you restore meetings without their original roster backup, review audience labels before using attendance reports. Label assignments, attendance rules, and the recent window travel with the roster category, while each meeting's audience selection travels with the meetings category. Older backups without labels restore meetings as **All** and do not invent member labels or attendance rules.

Operational web-update locks and recovery records are deliberately outside the dashboard category backups. They prevent an old restore from erasing an active deployment claim. Worker update credentials are secrets and are never in a backup.

Entire-installation restore validates table ownership, installation scope, module contracts, dependencies, lifecycle state, setup progress, Operator assignments, saved reports, and walkthrough progress before any destructive database statement runs. It then creates fresh local module authority instead of importing old epochs or leases.

Portable restore preserves encrypted Google and other integration records only when the installation encryption secrets are unchanged. It stops pending provider, Calendar, notification, anomaly, and Outreach publication work for explicit review. It also invalidates all restored pairing codes and kiosk credentials and takes restored simulator sessions offline. Re-pair each physical kiosk, confirm its selected authentication method, and review provider operations after restore. Do not copy a historical queue to a new pairing or another device. Server restore cannot erase local authentication mappings; remove them from **Authentication maintenance** on each kiosk before repurposing or decommissioning it.

This portable-restore boundary differs from an ordinary in-place web update. A normal compatible update preserves the active Community kiosk credential, pairing, mappings, and queued scans. Existing Community kiosk credentials remain compatible with their pre-upgrade unbound queue. Every new or replacement pairing is pairing-bound: each new scan captures that pairing, and a queued scan from an older pairing is rejected and retained in the kiosk's local review record instead of being attached to the replacement kiosk.

## D1 export and restore

The physical kiosk's **Authentication maintenance → Unpair kiosk** control creates a protected local archive before returning to setup. This archive contains the old installation's credential, local attendance history, mappings, roster cache and sharing state, not reader templates. It is not portable into another installation and is never restored automatically. It preserves the local PIN and Wi-Fi connections. Retire the original dashboard device separately, since local unpairing alone does not revoke the archived credential. See [KIOSK.md](KIOSK.md) for the confirmed transition and interrupted-archive recovery procedure.

For a larger or infrastructure-level recovery, work from the adopter-owned private repository checkout. Create a fresh export before an upgrade or restore. Put `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the current shell through the organization's approved secret-handling method, not a command line or repository file.

```sh
npm run backup-d1 -- --database sample-club-data --output lancerlogin-backup.sql
```

The helper refuses to overwrite an existing backup. Store the export securely, and record the installed release and UTC export time beside it.

Restore only to the same adopter-owned installation after taking a fresh pre-restore export:

```sh
npm run restore-d1 -- --database sample-club-data --file lancerlogin-backup.sql --confirm "RESTORE sample-club-data"
```

Replace `sample-club-data` with the private installation database name. Verify members, meetings, attendance events, corrections, audit records, and settings before reopening normal writes. If `INTEGRATION_KEY` changed, rotate the affected integration. Do not restore a historical kiosk queue or a backup into another organization automatically.

A raw D1 export is infrastructure state, not a portable dashboard backup. It can contain operational leases, update locks, kiosk authority, pending provider work, fingerprint relay ciphertext/public keys and associated member/device metadata, and durable server-encrypted vault templates/authority. Its restore requires a separately reviewed recovery plan that explicitly reconciles those authorities before normal writes resume. The vault's separate root secret is outside D1; preserve it independently, since ciphertext plus that secret allows decryption. Treat Pi state backups as credential-bearing biometric-related material too: enabled sync adds private keys, approved peer identities, encrypted outbox messages and slot/retry metadata, and cloud storage adds immutable mapping and delivery metadata. A backup may retain information already removed from live state. Do not put either kind of backup in source, chat, or support logs.

Cloudflare documents D1 exports and its separate Time Travel recovery capability in its [D1 documentation](https://developers.cloudflare.com/d1/). Use those provider controls only with an explicit recovery plan for the intended installation.

For label assignment and rule behavior, see [Member labels and attendance policies](ATTENDANCE-POLICIES.md).
