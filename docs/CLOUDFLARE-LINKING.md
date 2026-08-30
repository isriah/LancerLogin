# Link your Cloudflare account

LancerLogin deploys only into the adopter's own Cloudflare account. The setup never asks for an account ID in source code and never reuses another installation's account, database, Worker, Pages project, or token.

## Guided setup

1. In the dashboard, choose **Connect Cloudflare**.
2. If you do not have an account, use the displayed Cloudflare sign-up link and return after confirming your email.
3. In Cloudflare, create a narrowly scoped API token following the on-screen permission checklist. Limit it to the one account you intend to use for LancerLogin. Grant Account Settings Read plus Workers Scripts Edit, D1 Edit, and Pages Edit; do not grant zone, DNS, billing, or user-management permissions.
4. In your GitHub repository, open **Settings → Secrets and variables → Actions** and add the token as `CLOUDFLARE_API_TOKEN`. The dashboard never receives or stores this token.
5. Run the repository's **Provision adopter installation** workflow in `create` mode and type `CREATE <slug>`. The workflow refuses matching D1, Worker, or Pages resources instead of overwriting them. If a previous run was interrupted after creating resources, deliberately choose `resume` and type `RESUME <slug>`.

## Safety checks

- The workflow accepts a new installation slug only; it rejects existing installation IDs and resource identifiers.
- Generated secrets are stored in the adopter's deployment environment, never committed to Git.
- Resume generates secrets only if the Worker does not yet exist. If it exists, the workflow redeploys code without rotating its session or integration-encryption keys.
- The Actions log must redact token values and show only resource names generated from the chosen slug.
- If a user revokes the token, provisioning stops without modifying a different account.

The workflow is manual and adopter-run. Local development and pull-request verification never invoke it.
