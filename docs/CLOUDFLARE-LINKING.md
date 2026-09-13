# Link your Cloudflare account

LancerLogin keeps public source and private deployment authority separate. It deploys only into the adopter's own Cloudflare account. No account ID, token, setup code, or private deployment URL is committed to the public source repository.

## Guided setup

1. Select **Use this template** on the [public LancerLogin repository](https://github.com/isriah/LancerLogin) and create a **private** deployment repository in the adopter's account. Do not fork the public repository for a private installation.
2. In the private repository, open **Settings → Environments**, create an environment with the exact name `production`, and optionally add a required reviewer when the GitHub plan supports it.
3. [Create or sign in to Cloudflare](https://dash.cloudflare.com/) and select the adopter-owned account that will hold the installation. Creating an account-owned token requires Super Administrator access to that account.
4. Open **Manage account → Account API tokens → Create Token**. Give the token a human-readable label such as `LancerLogin deployment`. The label is not a credential and does not need to match a GitHub secret name.
5. None of Cloudflare's displayed templates has the exact least-privilege combination. Select **Start from scratch**, restrict the policy to the selected account, and grant only Workers Scripts Edit, D1 Edit, Pages Edit, and Account Settings Read. Do not grant zone, DNS, billing, member, or user-management permissions.
6. Review the four permission lines, create the token, and copy its value immediately. Cloudflare shows the value once. Never capture the reveal screen in a screenshot.
7. From any Cloudflare dashboard page, open Quick search or press **Ctrl/Command+K**, enter `Copy account ID`, and select that exact command. This copies the account ID, not a zone ID.
8. In the private repository's `production` environment, add three **environment secrets**: the Cloudflare token value as `CLOUDFLARE_API_TOKEN`, the 32-character account ID as `CLOUDFLARE_ACCOUNT_ID`, and a unique password-manager-generated value of at least 16 characters as `LANCERLOGIN_SETUP_CODE`. Use secrets, not environment variables. The setup code protects the public first-Admin page; it is not the Admin password.
9. Run **Install or upgrade LancerLogin** in `create` mode, keep **Latest stable** selected, and type `CREATE <slug>`. The workflow refuses to run from a public repository, verifies that the token is active in the exact selected account, and refuses matching D1, Worker, or Pages resources. After deployment, enter the setup code once in the first-Admin form. Use `resume` with `RESUME <slug>` only after an interrupted run. For a routine update, select `upgrade`, keep **Latest stable** selected, and type `UPGRADE <slug>`.

The task-oriented public walkthrough at [`setup.html`](https://isriah.github.io/LancerLogin/setup.html) contains sanitized screenshots captured from the real GitHub and Cloudflare interfaces. It never shows a token value, account ID, or private repository name.

## Safety checks

- The workflow resolves **Latest stable** from public GitHub Releases and checks out that exact tag rather than deploying a stale template snapshot.
- The workflow refuses Cloudflare deployment from a public repository.
- The workflow accepts a new installation slug only; it rejects existing installation IDs and resource identifiers.
- Generated secrets are stored in the adopter's deployment environment, never committed to Git.
- Resume generates secrets only when the complete Worker secret set does not yet exist. Upgrade never rotates the session, integration-encryption, or bootstrap-code hash.
- The Actions log must redact token values and show only resource names generated from the chosen slug.
- If a user revokes the token, provisioning stops without modifying a different account.

The workflow is manual and adopter-run. Local development and pull-request verification never invoke it.
