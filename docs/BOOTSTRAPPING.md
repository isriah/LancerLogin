# Browser-led setup design

## Adopter flow

1. Use the public LancerLogin repository as a GitHub template in the adopter's own account and choose **Private** for the generated deployment repository. Public source, releases, CI, and documentation remain in `isriah/LancerLogin`; adopter deployment history and credentials remain private.
2. Before a dashboard exists, open the public [setup walkthrough](https://isriah.github.io/LancerLogin/setup.html) and [Cloudflare dashboard](https://dash.cloudflare.com/) in the browser. Under **Manage account → Account API tokens**, choose **Create Token**, name it for human reference, select **Start from scratch** instead of a template, and grant only Workers Scripts Edit, D1 Edit, Pages Edit, and Account Settings Read for the selected account. [The account-linking guide](CLOUDFLARE-LINKING.md) explains this flow.
3. In the private repository, create a `production` environment. Add the token value—not its Cloudflare label—as the environment secret `CLOUDFLARE_API_TOKEN`. Use Cloudflare Quick search and the exact `Copy account ID` command, then add that 32-character value as `CLOUDFLARE_ACCOUNT_ID`. Add a unique password-manager-generated value of at least 16 characters as `LANCERLOGIN_SETUP_CODE`. Use secrets, not variables. Add a required environment reviewer when the GitHub plan supports it.
4. Run **Install or upgrade LancerLogin** in `create` mode. Keep **Latest stable** selected, type `CREATE <slug>`, and keep the installation slug recorded with the private repository. The workflow refuses to run from a public repository, resolves the latest public release, verifies the exact Cloudflare account-token pair, creates the adopter-named Worker, D1 database, Pages dashboard, and Worker secrets, then outputs the Pages URL. Use `resume` with `RESUME <slug>` only after an interrupted run.
5. Open the Pages URL and enter the private `LANCERLOGIN_SETUP_CODE` before creating the first Admin. The Worker stores only its SHA-256 hash, and the bootstrap route closes permanently once the installation record exists. Local setup requires matching password fields. If Google OAuth is selected, the form links to the public [Google OAuth setup guide](https://isriah.github.io/LancerLogin/setup.html#google-oauth) and keeps the installation's exact authorized redirect URI visible and copyable beside the credential fields. The OAuth secret is encrypted before storage and is never displayed again.
6. Review anonymous usage reporting, which is enabled by default, and uncheck it to opt out. The plain summary is: **Anonymous usage data only. No roster or user data is ever shared.** It can be changed later under **Settings → Privacy**.
7. Complete the one-step-at-a-time wizard: organization and brand, roster, hardware or simulator pairing, kiosk input test, and attendance confirmation. Steps are skippable and resumable across Admins. Integrations are separate and optional. The final confirmation shows an accessible celebration; dismiss it to enter dashboard Home.
8. On the Pi, download and run one guided installer. It installs and starts the unpaired local service without asking for a Worker URL, kiosk name, or code. The dashboard then creates one time-limited pairing key containing those values. From a phone or laptop on the same network, open the `.local` or LAN-IP address printed by the installer and paste the key. No repository clone or manual source edit is required. Hardware-free acceptance may use the browser simulator instead.

## Upgrade flow

After a reviewed public release is available, open **Settings → Updates**. The dashboard checks the public release feed, downloads a required entire-installation backup, and opens the workflow URL recorded from the adopter's authenticated private repository. It never dispatches the workflow. Choose `upgrade`, keep **Latest stable** selected, enter the existing slug, then type `UPGRADE <slug>`. The workflow resolves and checks out the latest public release, requires the named Worker, D1 database, Pages project, and retained Worker secrets, applies migrations, and redeploys without replacing D1 data or rotating secrets.

Application upgrades do not rewrite the private repository's workflow file. A private repository made from a pre-v0.7.0 template may still display the older optional exact-tag text box; leave it empty while **latest** is selected. Newer template repositories use the simplified dropdown. Copy a newer workflow into an existing private repository only as a separate, reviewed repository change.

## Deployment safety

Local tests use fake bindings and fake integration clients. The provisioning workflow is the only account-changing path. It fails before credential use when the repository is public, runs only from a manual private-repository dispatch, validates the selected `create`, `resume`, or `upgrade` operation and installation slug, and rejects resource collisions in `create` mode.

## Required first-run inputs

- organization name, optional subtitle/logo, primary/secondary colors, and mode
- one or both authentication methods
- first Admin identity or local credentials
- Google OAuth client ID and client secret when Google or both sign-in methods are selected
- time zone
- anonymous usage reporting choice, enabled by default with an opt-out checkbox
