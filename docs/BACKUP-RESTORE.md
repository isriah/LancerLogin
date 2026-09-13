# Data retention, export, backup, and restore

LancerLogin retains roster, meetings, attendance, audit data, settings, and encrypted integration settings until an Admin deletes them. Exporting creates a copy and does not delete the stored records. CSV is the supported report export format. PDF and spreadsheet exports are not included.

## Dashboard category backups

Open **Settings → Data** for three independent controls:

- **Meetings and attendance** backs up or restores meetings, check-ins, corrections, excuses, and Discord attendance contests. Its delete action leaves the roster, accounts, settings, and integrations intact.
- **Roster** backs up or restores roster identity/contact/link state. Dashboard accounts are deliberately separate. Roster deletion is blocked while attendance history still references members; delete Meetings and attendance first if that is intentional.
- **Entire installation** backs up or restores supported portable application records. Short-lived OAuth, Picker, interaction and feasibility proof authority is excluded; a raw D1 export includes those tables and requires the separate recovery procedure. This file includes password hashes, encrypted integration values, kiosk credential hashes, settings, and audit history. Protect it like an administrator credential and restore it only while the installation encryption secrets are unchanged.

Every JSON backup records its scope and schema version. The dashboard refuses cross-category restores and requires an exact `RESTORE <CATEGORY>` confirmation. Dashboard restore supports files up to 10 MiB; use the D1 workflow below for larger or infrastructure-level recovery. **Reset onboarding** clears only shared checklist progress and then reopens Setup; it does not delete organization data.

Installation schema 26 adds member note provenance, immutable curation snapshots and opaque submission receipts; older notes normalize to staff authors. Referenced members retain their history. Public admission counters remain transient. See [member note recovery](MEMBER-DOCUMENTATION.md#recovery-and-verification-boundary).

Installation schema 25 adds versioned definitions, claim histories, exact evidence revision pins and immutable staff reviews. Older schemas initialize them empty; attendance-only restore preserves them. See [claim recovery](DOCUMENTATION-CLAIMS.md#portable-and-raw-recovery).

Installation schema 24 adds external-link artifact history/reviews and durable shared Drive root inventory. Restored root verification is cleared; reselect and verify before file operations. Older schemas initialize empty records and enable the files section. See [artifact recovery](DOCUMENTATION-ARTIFACTS.md#sections-and-recovery).

Installation schema 23 adds exact-decimal manual metric fields and full activity/initiative association histories. Versions1-22 initialize empty metrics; attendance-only restore preserves them. See [metric backup constraints](DOCUMENTATION-METRICS.md#backup-and-evidence).

Installation schema 22 adds private initiative narratives, current memberships and complete revision memberships. Older versions initialize empty initiatives; attendance-only restore preserves them. See [initiative backup constraints](DOCUMENTATION-INITIATIVES.md#backup-and-verification-boundary).

Installation schema 21 also includes private Documentation sections, notes and complete immutable revision history. Versions 1-20 normalize to empty Documentation records with default sections. Attendance-only restore preserves Documentation. See [Documentation foundation](DOCUMENTATION-FOUNDATION.md).

Installation schema 20 introduced Hours publication ownership and outbox state. Installation restore rejects live or uncertain publication requests and older backups that omit unresolved provider ownership. Finish owned cleanup or use a current backup; see [Hours publication restore constraints](HOURS-PUBLICATION.md#backup-and-restore-boundary). Attendance-only restore preserves these records.

## D1 backup

From the adopter-owned repository checkout, create a D1 export before upgrades or bulk deletion. Create a fresh narrowly scoped Account API Token if the setup token is no longer available, then expose it to the process as `CLOUDFLARE_API_TOKEN` and expose the selected account ID as `CLOUDFLARE_ACCOUNT_ID` without putting either value in a command line or repository file. Replace `sample-club` with the installation slug used by the provisioning workflow:

```sh
npm run backup-d1 -- --database sample-club-data --output lancerlogin-backup.sql
```

The helper refuses to overwrite an existing backup. Store the export securely because it contains personal attendance data and encrypted integration ciphertext. Record the release version and UTC export time alongside it. The command verifies the account-owned token against the exact `CLOUDFLARE_ACCOUNT_ID`, and the repository contains no adopter account identifier.

## Restore

Restore only into the same adopter-owned installation after taking a fresh pre-restore export:

```sh
npm run restore-d1 -- --database sample-club-data --file lancerlogin-backup.sql --confirm "RESTORE sample-club-data"
```

The exact confirmation phrase is required. Verify row counts for members, meetings, attendance events, corrections, audit records, and settings before opening the dashboard. Encrypted integration values require the same installation's `INTEGRATION_KEY`; rotate integrations if that secret changed. Re-pair a kiosk only if its pairing record was restored inconsistently. Never restore data into another organization without an explicit privacy and retention review.

Each category delete action is separate and requires its own typed confirmation. Deleting an entire installation returns it to first-Admin setup. There is no live migration path from another attendance installation. Exported roster rows and local R503 slot mappings can be prepared with the kiosk helper described in `docs/KIOSK.md`; biometric templates are not exported or transferred.

## Modular development Staff migration

Migration 0030 adds a replacement role column with the Admin/Operator/Staff check, copies every existing role, drops only the old non-key role column, and renames the replacement. It never drops or renames the users table or disables foreign keys. Users, password hashes, roster links, audit references and module grants are preserved. The replacement column has a fail-closed Staff default; application account creation still requires an explicit role.

This uses documented [SQLite ADD/DROP/RENAME COLUMN](https://www.sqlite.org/lang_altertable.html) behavior: the original role's inline check belongs to the dropped column and no index, trigger, view or foreign key references that column. [D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/) remains the deployment engine. A populated local workerd/D1 upgrade and the full fresh migration chain prove the repository schema, not arbitrary adopter schema modifications or a remote deployment.

New dashboard backups use schema version 15 so older application versions reject them before attempting restoration. Versions 1–14 remain accepted by this release with existing normalization. Staff roles and module grants round-trip with the same installation secrets; invalid roles or a configured installation without an active Admin are rejected before deletion. Take a pre-upgrade D1 backup. A code rollback to the pre-Staff release rejects Staff sessions at verification and cannot provide a Staff workspace; do not relabel Staff as Operators for compatibility. Database rollback requires a separately verified restoration of the pre-upgrade backup and can discard changes made after it.

WU162: portable format27 adds durable file/upload inventory; migration0047 preserves existing link artifact revision pins. See [Documentation uploads](DOCUMENTATION-UPLOADS.md) for transient credential exclusion, uncertain-effect guards and Drive binary limitations. Local schema47 verification does not replace hosted recovery acceptance.
