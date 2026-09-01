# Link your Cloudflare account

LancerLogin keeps public source and private deployment authority separate. It deploys only into the adopter's own Cloudflare account. No account ID, token, setup code, or private deployment URL is committed to the public source repository.

## Guided setup

1. Select **Use this template** on the public LancerLogin repository and create a **private** deployment repository in the adopter's account.
2. If you do not have an account, use the displayed Cloudflare sign-up link and return after confirming your email.
3. In Cloudflare, create a narrowly scoped **Account API Token** following the on-screen permission checklist. Account-owned tokens are intended for durable CI/CD integrations. Limit it to the one account you intend to use for LancerLogin. Grant Account Settings Read plus Workers Scripts Edit, D1 Edit, and Pages Edit; do not grant zone, DNS, billing, or user-management permissions.
4. Copy the selected account's Account ID from Cloudflare's account overview. In the private GitHub repository, open **Settings → Environments → production** and add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as environment secrets.
5. Generate and save a unique value of at least 16 characters in a password manager, then add the same value as the `LANCERLOGIN_SETUP_CODE` environment secret. This protects the public first-Admin page; it is not the Admin password.
6. Run **Install or upgrade LancerLogin** in `create` mode, select a reviewed release tag, and type `CREATE <slug>`. The workflow refuses to run from a public repository, verifies that the token is active in the exact selected account, and refuses matching D1, Worker, or Pages resources. After deployment, enter the setup code once in the first-Admin form. Use `resume` with `RESUME <slug>` only after an interrupted run. For a routine update, choose a newer reviewed release tag, select `upgrade`, and type `UPGRADE <slug>`.

## Safety checks

- The workflow fetches the selected public release tag rather than deploying a stale template snapshot.
- The workflow refuses Cloudflare deployment from a public repository.
- The workflow accepts a new installation slug only; it rejects existing installation IDs and resource identifiers.
- Generated secrets are stored in the adopter's deployment environment, never committed to Git.
- Resume generates secrets only when the complete Worker secret set does not yet exist. Upgrade never rotates the session, integration-encryption, or bootstrap-code hash.
- The Actions log must redact token values and show only resource names generated from the chosen slug.
- If a user revokes the token, provisioning stops without modifying a different account.

The workflow is manual and adopter-run. Local development and pull-request verification never invoke it.
