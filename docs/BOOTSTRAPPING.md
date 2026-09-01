# Browser-led setup design

## Adopter flow

1. Use the public LancerLogin repository as a GitHub template in the adopter's own account and choose **Private** for the generated deployment repository. Public source, releases, CI, and documentation remain in `isriah/LancerLogin`; adopter deployment history and credentials remain private.
2. In the dashboard, follow **Connect Cloudflare** to create or select the adopter's own account and generate a narrowly scoped token. [The account-linking guide](CLOUDFLARE-LINKING.md) explains this flow.
3. In the private repository, create a `production` environment. Add the token as `CLOUDFLARE_API_TOKEN`, the selected account ID as `CLOUDFLARE_ACCOUNT_ID`, and a unique password-manager-generated value of at least 16 characters as `LANCERLOGIN_SETUP_CODE`. Add a required environment reviewer when the GitHub plan supports it.
4. Run **Install or upgrade LancerLogin** in `create` mode. Select a reviewed public release tag, type `CREATE <slug>`, and keep the installation slug recorded with the private repository. The workflow refuses to run from a public repository, checks out only that public release tag, verifies the exact Cloudflare account-token pair, creates the adopter-named Worker, D1 database, Pages dashboard, and Worker secrets, then outputs the Pages URL. Use `resume` with `RESUME <slug>` only after an interrupted run.
5. Open the Pages URL and enter the private `LANCERLOGIN_SETUP_CODE` before creating the first Admin. The Worker stores only its SHA-256 hash, and the bootstrap route closes permanently once the installation record exists. Local setup requires matching password fields. If Google OAuth is selected, the form links directly to project creation, OAuth consent, and Web client creation in Google Cloud and shows both the authorized origin and exact callback. The OAuth secret is encrypted before storage and is never displayed again.
6. Review anonymous usage reporting, which is enabled by default, and uncheck it to opt out. The plain summary is: **Anonymous usage data only. No roster or user data is ever shared.** It can be changed later under **Settings → Privacy**.
7. Complete the one-step-at-a-time wizard: organization and brand, initial test meeting, roster, hardware or simulator pairing, kiosk input test, and attendance confirmation. Steps are skippable and resumable across Admins. Integrations are separate and optional. The final confirmation shows an accessible celebration; dismiss it to enter dashboard Home.
8. On the Pi, download one guided installer from the dashboard. It prompts for the Pages URL and a short-lived pairing code; it does not clone a repository or require manual source edits. Hardware-free acceptance may use the browser simulator instead.

## Upgrade flow

After a reviewed public release is available, open **Settings → Updates**. The dashboard checks the public release feed, downloads a required entire-installation backup, and opens the workflow URL recorded from the adopter's authenticated private repository. It never dispatches the workflow. Choose `upgrade`, enter the new release tag and existing slug, then type `UPGRADE <slug>`. The workflow checks out that release from the public source repository, requires the named Worker, D1 database, Pages project, and retained Worker secrets, applies migrations, and redeploys without replacing D1 data or rotating secrets.

## Deployment safety

Local tests use fake bindings and fake integration clients. The provisioning workflow is the only account-changing path. It fails before credential use when the repository is public, runs only from a manual private-repository dispatch, rejects resource collisions in `create` mode, and requires a separate typed confirmation for every operation.

## Required first-run inputs

- organization name, optional subtitle/logo, primary/secondary colors, and mode
- one or both authentication methods
- first Admin identity or local credentials
- Google OAuth client ID and client secret when Google or both sign-in methods are selected
- time zone
- anonymous usage reporting choice, enabled by default with an opt-out checkbox
