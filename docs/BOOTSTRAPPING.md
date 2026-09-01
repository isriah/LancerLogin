# Browser-led setup design

## Adopter flow

1. Use this repository as a GitHub template in the adopter's own GitHub account.
2. In the dashboard, follow **Connect Cloudflare** to create or select the adopter's own account and generate a narrowly scoped token. [The account-linking guide](CLOUDFLARE-LINKING.md) explains this flow.
3. In GitHub, add that token as `CLOUDFLARE_API_TOKEN` and the selected account ID as `CLOUDFLARE_ACCOUNT_ID`, then run **Install or upgrade LancerLogin** in `create` mode. Type the required `CREATE <slug>` confirmation. The workflow verifies the exact pair, creates an adopter-named Worker, D1 database, Pages dashboard, deployment secrets, and initial state, then outputs the Pages URL. Use `resume` with `RESUME <slug>` only after an interrupted run.
4. Open the Pages URL and create the first Admin. Local setup requires matching password fields. If Google OAuth is selected, the form links directly to project creation, OAuth consent, and Web client creation in Google Cloud and shows both the authorized origin and exact callback. The secret is encrypted before storage and is never displayed again.
5. Review anonymous usage reporting, which is enabled by default, and uncheck it to opt out. The plain summary is: **Anonymous usage data only. No roster or user data is ever shared.** It can be changed later under **Settings → Privacy**.
6. Complete the one-step-at-a-time wizard: organization and brand, initial test meeting, roster, hardware or simulator pairing, kiosk input test, and attendance confirmation. Steps are skippable and resumable across Admins. Integrations are separate and optional. The final confirmation shows an accessible celebration; dismiss it to enter dashboard Home.
7. On the Pi, download one guided installer from the dashboard. It prompts for the Pages URL and a short-lived pairing code; it does not clone a repository or require manual source edits. Hardware-free acceptance may use the browser simulator instead.

## Upgrade flow

After repository changes are available, open **Settings → Updates**. The dashboard checks the public release feed and can download a required entire-installation backup before opening **Install or upgrade LancerLogin** in GitHub. It never dispatches the workflow. In GitHub, choose operation `upgrade`, enter the existing slug, and type `UPGRADE <slug>`. Upgrade refuses to proceed unless the named Worker, D1 database, Pages project, and Worker secrets already exist. It applies the migration chain, redeploys Worker and Pages, preserves D1 data, and does not rotate installation secrets.

## Deployment safety

Local tests use fake bindings and fake integration clients. The provisioning workflow is the only account-changing path. It runs only from a manual GitHub dispatch with the adopter's secret, rejects resource collisions in `create` mode, and requires a separate typed confirmation to resume an interrupted installation.

## Required first-run inputs

- organization name, optional subtitle/logo, primary/secondary colors, and mode
- one or both authentication methods
- first Admin identity or local credentials
- Google OAuth client ID and client secret when Google or both sign-in methods are selected
- time zone
- anonymous usage reporting choice, enabled by default with an opt-out checkbox
