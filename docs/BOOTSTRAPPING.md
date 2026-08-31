# Browser-led setup design

## Adopter flow

1. Use this repository as a GitHub template in the adopter's own GitHub account.
2. In the dashboard, follow **Connect Cloudflare** to create or select the adopter's own account and generate a narrowly scoped token. [The account-linking guide](CLOUDFLARE-LINKING.md) explains this flow.
3. In GitHub, add that token as `CLOUDFLARE_API_TOKEN` and the selected account ID as `CLOUDFLARE_ACCOUNT_ID`, then run **Provision adopter installation** in `create` mode. Type the required `CREATE <slug>` confirmation. The workflow verifies the exact pair, creates an adopter-named Worker, D1 database, Pages dashboard, deployment secrets, and initial state, then outputs the Pages URL. Use `resume` with `RESUME <slug>` only after an interrupted run.
4. Open the Pages URL and create the first Admin. If Google OAuth is selected, create the Google Web OAuth client first, register the callback shown on the setup form, and enter its client ID and secret there. The secret is encrypted before storage and is never displayed again. Accept the privacy notice before telemetry can be enabled.
5. Complete the resumable setup checklist: branding, roster, dashboard auth, kiosk pairing, fingerprint test, test meeting, and attendance confirmation. Integrations are separate, skippable checklist items.
6. On the Pi, download one guided installer from the dashboard. It prompts for the Pages URL and a short-lived pairing code; it does not clone a repository or require manual source edits.

## Deployment safety

Local tests use fake bindings and fake integration clients. The provisioning workflow is the only account-changing path. It runs only from a manual GitHub dispatch with the adopter's secret, rejects resource collisions in `create` mode, and requires a separate typed confirmation to resume an interrupted installation.

## Required first-run inputs

- organization name, optional subtitle/logo, primary/secondary colors, and mode
- one or both authentication methods
- first Admin identity or local credentials
- Google OAuth client ID and client secret when Google or both sign-in methods are selected
- time zone
- consent choice for telemetry
