# Data retention, export, backup, and restore

LancerLogin retains roster, meetings, attendance, audit data, settings, and encrypted integration settings until an Admin deletes or exports them. CSV is the supported export format. PDF and spreadsheet exports are not included.

## D1 backup

From the adopter-owned deployment environment, create a D1 export before upgrades or bulk deletion. Store the export securely because it contains personal attendance data and encrypted integration ciphertext. Record the release version and UTC export time alongside it. The public release will provide exact account-neutral commands; this repository intentionally has no database name or account identifier.

## Restore

Restore only into the same adopter-owned installation after taking a fresh pre-restore export. Verify row counts for members, meetings, attendance events, corrections, audit records, and settings before opening the dashboard. Re-pair a kiosk only if its pairing record was restored inconsistently. Never restore data into another organization without an explicit privacy and retention review.

Deleting an installation is destructive configuration and requires Admin confirmation plus a final export prompt. There is no migration path from another attendance installation.
