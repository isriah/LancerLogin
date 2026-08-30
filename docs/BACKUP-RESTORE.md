# Data retention, export, backup, and restore

LancerLogin retains roster, meetings, attendance, audit data, settings, and encrypted integration settings until an Admin deletes them. Exporting creates a copy and does not delete the stored records. CSV is the supported report export format. PDF and spreadsheet exports are not included.

## D1 backup

From the adopter-owned repository checkout, create a D1 export before upgrades or bulk deletion. Replace `<slug>` with the installation slug used by the provisioning workflow:

```sh
npx wrangler d1 export <slug>-data --remote --output lancerlogin-backup.sql
```

Store the export securely because it contains personal attendance data and encrypted integration ciphertext. Record the release version and UTC export time alongside it. The command discovers the account through the adopter's scoped Cloudflare token; this repository contains no account identifier.

## Restore

Restore only into the same adopter-owned installation after taking a fresh pre-restore export:

```sh
npx wrangler d1 execute <slug>-data --remote --file lancerlogin-backup.sql
```

Verify row counts for members, meetings, attendance events, corrections, audit records, and settings before opening the dashboard. Encrypted integration values require the same installation's `INTEGRATION_KEY`; rotate integrations if that secret changed. Re-pair a kiosk only if its pairing record was restored inconsistently. Never restore data into another organization without an explicit privacy and retention review.

Deleting an installation is destructive configuration and requires Admin confirmation plus a final export prompt. There is no migration path from another attendance installation.
