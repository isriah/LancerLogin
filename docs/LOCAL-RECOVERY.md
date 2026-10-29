# Local recovery

The step-by-step procedure for regaining access when every Admin has lost their password is on the documentation site: [Recover access](https://isriah.github.io/LancerLogin/operations.html#recover-access). This page records how the recovery tool works.

## Password reset tool

`npm run reset-password -- --database <installation-slug>-data --username <local-username>` resets one local account's password directly in the installation's D1 database. It deliberately does not run through the public dashboard.

- It requires an interactive terminal and reads the new password twice from hidden prompts. It rejects non-interactive input and has no password argument.
- It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the terminal environment. The token needs Account Settings read and D1 edit access in the adopter-owned account. The tool verifies the exact account-token pair before it touches D1. Never paste either value into LancerLogin or commit it.
- It derives the same salted scrypt hash the Worker uses and runs one Wrangler D1 update against the named database. The update also clears any failed-login lock.
- Wrangler reports `passwords_reset: 1` on success. A zero count means the username was not found; it is safe to rerun with the corrected name.
- It never prints the password or the derived hash.

Google-only Admins recover access through their Google account instead.

## Kiosk and update recovery

- A **dashboard update** that reports recovery required keeps the installation in maintenance until reviewed. Do not start another update or restore D1 automatically. See [web updates](WEB-UPDATES.md#recovery).
- A **kiosk update** that fails its health check is rolled back automatically to the previous release by the installer, with its earlier systemd units and helper. See [kiosk reference](KIOSK.md#release-directories-and-automatic-rollback).

For manual kiosk recovery, use the access method the installation already has (in person, SSH, or Raspberry Pi Connect). Preserve a private copy of `/var/lib/lancerlogin` first. Do not re-pair, recreate resources, restore an old queue, or restore D1 automatically: a historical queue can duplicate or discard attendance. Keep this state out of source control, chat and support tickets.
