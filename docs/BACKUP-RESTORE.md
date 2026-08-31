# Data retention, export, backup, and restore

LancerLogin retains roster, meetings, attendance, audit data, settings, and encrypted integration settings until an Admin deletes them. Exporting creates a copy and does not delete the stored records. CSV is the supported report export format. PDF and spreadsheet exports are not included.

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

Deleting an installation is destructive configuration and requires Admin confirmation plus a final export prompt. There is no migration path from another attendance installation.
