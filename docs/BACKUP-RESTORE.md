# Data backup and restore

This guide is for Administrators. Back up before a web update, bulk deletion, or recovery decision. A backup is sensitive: it can contain attendance information, password hashes, encrypted integration values, kiosk credential hashes, and audit history.

## Dashboard backups

Open **Settings → Data**. Each category has separate download, restore, and typed-confirmation deletion controls.

| Category | Includes | Important boundary |
| --- | --- | --- |
| Meetings and attendance | Meetings, scans, corrections, excuses, and contests | Deletion keeps roster, accounts, settings, integrations, and audit history. |
| Roster | Member identity/contact data, Discord links, and active state | Dashboard accounts remain separate. Historical members missing from a restore remain inactive when referenced. |
| Entire installation | All retained D1 state | Restore only while the installation encryption secrets are unchanged. |

Each JSON file records its scope and schema version. The dashboard rejects a file from another category and requires `RESTORE <CATEGORY>` exactly. Dashboard restore accepts files up to 10 MiB. **Reset onboarding** only reopens the shared Guided Setup checklist; it does not delete organization data.

Operational web-update locks and recovery records are deliberately outside the dashboard category backups. They prevent an old restore from erasing an active deployment claim. Worker update credentials are secrets and are never in a backup.

## D1 export and restore

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

Cloudflare documents D1 exports and its separate Time Travel recovery capability in its [D1 documentation](https://developers.cloudflare.com/d1/). Use those provider controls only with an explicit recovery plan for the intended installation.
