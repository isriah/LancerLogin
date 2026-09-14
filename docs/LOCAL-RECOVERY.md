# Local recovery

This guide is for an Administrator recovering a local dashboard password or an authorized Operator responding to a kiosk or update problem. It does not provide a public dashboard shortcut for either task.

## Reset a local Admin password

Local password recovery deliberately does not run through the public dashboard. It requires an interactive terminal, access to the adopter-owned repository, and a narrowly scoped Cloudflare token that can edit only the installation's D1 database.

1. Open a terminal in your LancerLogin repository checkout and run `npm ci`.
2. Create or reuse a Cloudflare Account API Token restricted to the adopter-owned account with Account Settings read and D1 edit access. Export it as `CLOUDFLARE_API_TOKEN` and export the selected account ID as `CLOUDFLARE_ACCOUNT_ID` only for this terminal session. Never paste either value into LancerLogin or commit it; the tool verifies the exact pair before accessing D1.
3. Run `npm run reset-password -- --database <installation-slug>-data --username <local-username>`.
4. Enter the new password twice at the hidden prompts. The tool derives the same salted scrypt format used by the Worker and invokes Wrangler against the named adopter-owned D1 database.
5. Confirm Wrangler reports `passwords_reset: 1`, clear the token from the terminal environment, and sign in with the new password. The reset also clears any temporary failed-login lock. A zero count means the username was not found; it is safe to rerun after correcting the name.

This tool never prints the password or derived hash and rejects non-interactive input. It does not work without the adopter's own Cloudflare authorization. Google-only Admins recover access through their Google account instead.

## Recover a physical kiosk or update

Use the current [physical kiosk guide](KIOSK.md#dashboard-management-and-recovery) for fixed dashboard actions and [web update guide](WEB-UPDATES.md#update-the-dashboard-installation) for dashboard-installation recovery. Keep these paths separate:

- A **web update** is managed from **Settings → Updates** and requires an entire-installation backup before it starts. Do not automatically restore D1 when it fails.
- A **physical kiosk update** changes Pi software only. It does not deploy the dashboard or create a web backup.

Use the Administrator's available local or remote access method for a physical-kiosk recovery. Raspberry Pi Connect remote shell, SSH, and direct access are all valid when the installation permits them. Before a manual recovery action, preserve a private checkpoint of the kiosk's state and keep its pairing, mappings, local settings PIN, and pending queue intact. Do not copy that state into source control, chat, or a support ticket.

If a kiosk update fails, the updater may restart a kiosk that was active before the failure but does not restore previous code bytes. Stop, inspect scrubbed service status through the available access method, and use an approved recovery plan. Do not re-pair, recreate resources, restore an old queue, or restore D1 automatically. A historical queue can duplicate or discard attendance.

The stable public release is v1.0.5. The completed migration used the terminal Pi updater successfully, while dashboard-driven Pi release lookup acceptance remains unproven. Treat a dashboard error or absent completion status as unconfirmed, not as proof that an update ran.
