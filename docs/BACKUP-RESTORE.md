# Data backup and restore

This is the reference for backup formats and restore behavior. The everyday steps are in [Back up, restore, or delete data](https://isriah.github.io/LancerLogin/operations.html#data) on the documentation site. Back up before a web update, bulk deletion, or recovery decision. A backup is sensitive: it can contain attendance information, password hashes, encrypted integration values, kiosk credential hashes, and audit history.

## Dashboard backups

The dashboard's rejected-scan review list is an operational mirror of protected records retained on each kiosk. It is excluded from portable dashboard backups; review audits remain in audit history. Preserve kiosk state separately before recovery or replacement. Authorized kiosks send each retained record until the dashboard acknowledges it, then only send local review changes and check open records for dashboard reviews; records already reviewed in the cloud are not resent. An installation restore also revokes kiosk credentials and requires the documented pairing/recovery procedure. Do not assume a dashboard backup alone preserves every rejected scan.

Open **Settings > Data**. Each category has separate download, restore, and typed-confirmation deletion controls.

| Category | Includes | Important boundary |
| --- | --- | --- |
| Meetings and attendance | Meetings, audience label selections, scans, corrections, excuses, and contests | Deletion keeps roster, member labels, accounts, settings, integrations, and audit history. |
| Roster | Member identity/contact data, Discord links, active state, dated label changes, label definitions, attendance rules, the recent compliance window, and policy activation date | Dashboard accounts remain separate. Historical members missing from a restore remain inactive when referenced. |
| Entire installation | Portable retained D1 state, including saved personal/shared reports, account-pinned report tabs, and Discord label-to-role associations | Restore only while the installation encryption secrets are unchanged. Operational role sync jobs and fingerprint relay state are not replayed from dashboard backups. |

Each JSON file records its scope and schema version. The dashboard rejects a file from another category and requires `RESTORE <CATEGORY>` exactly. Dashboard restore accepts files up to 10 MiB.

Backup schema 21 adds each account's page walkthrough progress and dismissal preference to entire-installation backups. Backups before schema 21 restore with no recorded walkthrough progress. Roster and meetings restores preserve walkthrough progress.

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

Backup schema 40 preserves each kiosk's configured authentication method independently from its last reported method. Migration 0073 copies the installation's effective method to existing devices without changing their reported state. Supported schemas 31-39 restore each kiosk's configured method from that backup's installation setting; older schemas use fingerprint. Current backups reject missing or invalid per-device methods before writes. Restored devices remain retired with revoked credentials and require re-pairing; newly paired devices start with fingerprint. Retained device records do not grant access.

Backup schema 31 adds the installation's configured kiosk authentication method. Earlier supported backups restore it as fingerprint, preserving the prior behavior. A retained reported method is historical diagnostic state and does not establish current device readiness. Fingerprint templates, slot mappings, badge and QR mappings, local credential transform secrets, local active-roster caches, and pending kiosk events are not included in dashboard backups. Portable restore still revokes every kiosk credential, so re-pair each device and review its owner-only local state before returning it to service.

Fingerprint sharing state is operational and non-portable. Dashboard exports exclude fingerprint cloud storage (`kiosk_fingerprint_vault_settings`, `kiosk_fingerprint_vault_templates`), reset batches and commands (`kiosk_fingerprint_reset_batches`, `kiosk_fingerprint_reset_commands`), the retired review tables (`kiosk_fingerprint_review_requests`, `kiosk_fingerprint_review_manifests`, `kiosk_fingerprint_review_slots`, `kiosk_fingerprint_retired_review_grants`) and historical peer-sync registrations and deliveries. An entire-installation restore removes cloud authority and ciphertext, clears reset and peer authority, and leaves cloud storage off. The separate `FINGERPRINT_VAULT_KEY` is a Worker secret, never a backup field; preserve it independently, since a replacement key cannot decrypt existing ciphertext. Before re-enabling cloud storage after a restore, renew the organization's biometric consent. Raw D1 exports and Pi backups may retain retired or deleted fingerprint metadata; protect them and never reuse them to authorize sharing. See [privacy](PRIVACY.md#optional-fingerprint-cloud-storage).

Schema 20 added saved report views and report-tab preferences to entire-installation backups. Older backups restore with an empty report library. Roster and meetings restores preserve existing reports. If a preserved report refers to a label that is absent after a category restore, the report displays an actionable warning and keeps the missing reference for editing instead of broadening its results.

Portable roster backups omit Discord role IDs. Restoring a roster keeps only existing role associations whose labels remain active, and stops any pending role sync. It does not modify Discord roles.

If you restore meetings without their original roster backup, review audience labels before using attendance reports. Label assignments, attendance rules, and the recent window travel with the roster category, while each meeting's audience selection travels with the meetings category. Older backups without labels restore meetings as **All** and do not invent member labels or attendance rules.

A meetings restore updates meetings that still exist by ID in place, so their live Google Calendar and Discord scheduled-event links survive and later syncs update the same external events instead of creating duplicates. These links are operational state of the running installation and are not part of the backup. Meetings absent from the backup are deleted with their links; their external events are left in place, and the restore response reports how many were detached as `recovery.detachedCalendarEvents`. Remove those events from the calendar or Discord server manually if they are no longer wanted.

Module access grants, which let one module call another without a signed-in user, are authority rather than data. Backups leave them out, and an entire-installation restore removes them. After a restore, review **Settings > Modules > Module access** and grant again; see [module access](MODULE-PLUGINS.md#module-access).

Operational web-update locks and recovery records are deliberately outside the dashboard category backups. They prevent an old restore from erasing an active deployment claim. Worker update credentials are secrets and are never in a backup.

A dashboard restore is one all-or-nothing database transaction, limited to 150,000 records. Cloudflare D1 also limits how long a single transaction may run (about 30 seconds) and how much memory it may use. If a large backup exceeds those limits, the transaction is rolled back, nothing changes, and the restore returns HTTP 503 with an explanation. Restore one category at a time, or use the D1 restore workflow below for very large installations.

Entire-installation restore validates table ownership, installation scope, module contracts, dependencies, lifecycle state, setup progress, Operator assignments, saved reports, and walkthrough progress before any destructive database statement runs. It then creates fresh local module authority instead of importing old epochs or leases.

Portable restore preserves encrypted Google and other integration records only when the installation encryption secrets are unchanged. It stops pending provider, Calendar, notification, anomaly, and Outreach publication work for explicit review. It also invalidates all restored pairing codes and kiosk credentials and takes restored simulator sessions offline. Re-pair each physical kiosk, confirm its selected authentication method, and review provider operations after restore. Do not copy a historical queue to a new pairing or another device. Server restore cannot erase local authentication mappings; remove them from **Authentication maintenance** on each kiosk before repurposing or decommissioning it.

This portable-restore boundary differs from an ordinary in-place web update. A normal compatible update preserves the active Community kiosk credential, pairing, mappings, and queued scans. Existing Community kiosk credentials remain compatible with their pre-upgrade unbound queue. Every new or replacement pairing is pairing-bound: each new scan captures that pairing, and a queued scan from an older pairing is rejected and retained in the kiosk's local review record instead of being attached to the replacement kiosk.

### Plugin modules

Backup schema 42 adds an `externalModules` section to entire-installation backups. Meetings and roster backups are unchanged and must not contain it. Core tables, column lists, ownership metadata and historical normalization describe only Core and the first-party modules, so the rest of the file is identical whether or not plugins are installed. Every installed plugin has one entry:

| Field | Meaning |
| --- | --- |
| `id`, `label` | The plugin's module ID and display name. |
| `contractVersion` | The module contract the plugin was built against. |
| `backupVersion` | The plugin's own backup format version. |
| `source`, `commit` | The plugin's git source and pinned commit, or `null` until the installed-module catalog records them. |
| `tables` | Rows of the plugin's declared portable tables for this installation, using only its declared columns. |

Plugin lifecycle, Operator assignment and setup rows stay in the Core module tables. A plugin's non-portable tables, such as stored credentials or leases, are never exported.

Restore validates the section strictly before any write: no unknown fields, only scalar values, only declared tables and columns, rows scoped to this installation, and plugin rows counted toward the same 150,000-record dashboard limit. An installed plugin then converts an older backup version, validates its rows, and neutralizes transient authority so credentials, leases and pending work do not revive. Restore clears every installed plugin's declared tables, including plugins that the backup does not contain, and writes plugin rows in the same atomic batch as Core data. An installed plugin absent from the backup starts disabled with a new generation and its default rows, as on a new installation.

Restore refuses, without changing anything, when the backup contains a plugin that is not installed, is newer than the installed plugin, or was exported under a different module contract. The response is HTTP 409 with `code: "module-restore-refused"` and lists each module with its ID, name, required backup and contract versions, installed versions, recorded source and commit, and record count. Install the listed plugin version and retry, or confirm a restore that discards those modules' data. In **Settings > Data**, the restore dialog names each module and its record count and requires a separate **Discard** checkbox before **Restore without these modules** becomes available. API clients send `excludeModules` with exactly the refused module IDs; any other list is refused.

The opt-out is unavailable while a restored module depends on a refused one. Install the missing dependency instead. Discarded modules restore as absent: they have no lifecycle, generation, Operator assignment or setup rows, and their data is not written. If a discarded module is still installed in an older version, it starts disabled and empty. The restore audit entry and the response record each discarded module with its record count.

Backups from schema 41 and earlier have no plugin section. They restore exactly as before; any plugins installed now are cleared and start fresh.

Lifecycle, assignment and setup rows of a module whose code is not in the build making the backup, such as a removed plugin, are left out of the file: it carries none of that module's data, and the build could not restore them.

### Carpool moved into a plugin

Backup schema 43 moves Carpool out of Core's section. Carpool's rows now travel in its plugin section (module backup version 2), and Core's ownership metadata lists only Attendance and Outreach. The columns are unchanged. Meetings and roster backups change only in their ownership metadata.

Backups from schema 30 through 42 were made while Carpool was first-party, and carry its tables in Core's section. Core still checks their ownership metadata exactly and then treats those rows as a Carpool module entry, backup version 1:

- With the Carpool plugin installed, the rows restore through its adapter, which applies the same historical defaults Core did (meeting links, trip scope and pin provenance, groups and rebuild recovery, trip timing, settings) and the same validation. Lifecycle, Operator assignments and setup progress restore as before, and kiosk handling is unchanged.
- Without the plugin, a backup that holds Carpool data or state (any Carpool row, Operator assignment or setup progress, or Carpool enabled, retained or deleting) is refused like any unavailable plugin. The refusal names Carpool, backup version 1 and its record count. Install the plugin and retry, or confirm a restore that discards Carpool with `excludeModules: ["carpool"]`; the discard is audited and Carpool restores as absent.
- Without the plugin, a backup in which Carpool was never used restores without a confirmation. Its disabled Carpool registration is left out, as there is nothing to discard.

A backup from schema 43 or later made without the Carpool plugin contains no Carpool data, even if Carpool data is still retained in the database. Compose the plugin before taking a backup that must include it.

### Outreach moved into a plugin

Backup schema 44 moves Outreach out of Core's section. Outreach is now the official Outreach plugin, included in installation builds by default. Its rows travel in its plugin section (module backup version 3), and Core's ownership metadata lists only Attendance. The columns are unchanged. Meetings and roster backups change only in their ownership metadata.

Backups from schema 25 through 43 were made while Outreach was first-party, and carry its tables in Core's section. Core still checks their ownership metadata exactly and then treats those rows as an Outreach module entry, backup version 2:

- With the Outreach plugin installed, the rows restore through its adapter, which applies the same historical defaults Core did (correction activities and public form privacy before schema 33, event times, publication settings and labels before schema 29, publication snapshots before schema 36) and the same validation. Pending and leased publication operations are paused for explicit retry and counted with the other paused provider operations. Lifecycle, Operator assignments, setup progress and walkthrough progress restore as before.
- Without the plugin, a backup that holds Outreach data or state (any Outreach row other than the default settings and labels every installation received, an Operator assignment or setup progress, or Outreach enabled, retained or deleting) is refused like any unavailable plugin. The refusal names Outreach Participation, backup version 2 and its record count. Install the plugin and retry, or confirm a restore that discards Outreach with `excludeModules: ["hour-tracking"]`; the discard is audited, Outreach restores as absent, and progress on its walkthrough is not restored. Saved reports on Outreach datasets are kept as saved.
- Without the plugin, a backup in which Outreach was never used restores without a confirmation. Its disabled registration and default rows are left out.

Backups before schema 25 contain no Outreach data. With the plugin installed, Outreach starts disabled, and its default settings and labels are created when it is first enabled, as on a new installation.

A backup from schema 44 or later made without the Outreach plugin contains no Outreach data, even if Outreach data is still retained in the database.

Plugin authors provide a backup adapter on their API contribution (`backup` in `apps/api/src/module-contributions.ts`). Its version must equal the manifest's `backup.version`, and its tables must be exactly the manifest's portable tables, in parent-first restore order, each with an `installation_id` column. A plugin that declares transient authority on a portable table must provide `neutralize`. Core clears non-portable tables first, then portable tables in reverse order, before Core rows are removed.

## D1 export and restore

The physical kiosk's **Authentication maintenance > Unpair kiosk** control creates a protected local archive before returning to setup. This archive contains the old installation's credential, local attendance history, mappings, roster cache and sharing state, not reader templates. It is not portable into another installation and is never restored automatically. It preserves the local PIN and Wi-Fi connections. Retire the original dashboard device separately, since local unpairing alone does not revoke the archived credential. See [KIOSK.md](KIOSK.md) for the confirmed transition and interrupted-archive recovery procedure.

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

A raw D1 export is infrastructure state, not a portable dashboard backup. It can contain operational leases, update locks, kiosk authority, pending provider work, fingerprint relay ciphertext/public keys and associated member/device metadata, and durable server-encrypted vault templates/authority. Its restore requires a separately reviewed recovery plan that explicitly reconciles those authorities before normal writes resume. The vault's separate root secret is outside D1; preserve it independently, since ciphertext plus that secret allows decryption. Treat Pi state backups as credential-bearing biometric-related material too: historical peer sync may retain private keys, approved peer identities, encrypted outbox messages and slot/retry metadata, and cloud storage adds immutable mapping and delivery metadata. A backup may retain information already removed from live state. Do not put either kind of backup in source, chat, or support logs.

Cloudflare documents D1 exports and its separate Time Travel recovery capability in its [D1 documentation](https://developers.cloudflare.com/d1/). Use those provider controls only with an explicit recovery plan for the intended installation.

For label assignment and rule behavior, see [Member labels and attendance policies](ATTENDANCE-POLICIES.md).
