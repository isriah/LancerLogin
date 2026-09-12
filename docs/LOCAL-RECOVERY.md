# Local Admin password recovery

Local password recovery deliberately does not run through the public dashboard. It requires an interactive terminal, access to the adopter-owned repository, and a narrowly scoped Cloudflare token that can edit only the installation's D1 database.

1. Open a terminal in your LancerLogin repository checkout and run `npm ci`.
2. Create or reuse a Cloudflare Account API Token restricted to the adopter-owned account with Account Settings read and D1 edit access. Export it as `CLOUDFLARE_API_TOKEN` and export the selected account ID as `CLOUDFLARE_ACCOUNT_ID` only for this terminal session. Never paste either value into LancerLogin or commit it; the tool verifies the exact pair before accessing D1.
3. Run `npm run reset-password -- --database <installation-slug>-data --username <local-username>`.
4. Enter the new password twice at the hidden prompts. The tool derives the same salted scrypt format used by the Worker and invokes Wrangler against the named adopter-owned D1 database.
5. Confirm Wrangler reports `passwords_reset: 1`, clear the token from the terminal environment, and sign in with the new password. The reset also clears any temporary failed-login lock. A zero count means the username was not found; it is safe to rerun after correcting the name.

This tool never prints the password or derived hash and rejects non-interactive input. It does not work without the adopter's own Cloudflare authorization. Google-only Admins recover access through their Google account instead.
