# Link your Cloudflare account

LancerLogin deploys only into the adopter's own Cloudflare account. The setup never asks for an account ID in source code and never reuses another installation's account, database, Worker, Pages project, or token.

## Guided setup

1. In the dashboard, choose **Connect Cloudflare**.
2. If you do not have an account, use the displayed Cloudflare sign-up link and return after confirming your email.
3. In Cloudflare, create a narrowly scoped API token following the on-screen permission checklist. Limit it to the account you intend to use for LancerLogin and the Worker, D1, and Pages permissions the guide names.
4. In your GitHub repository, open **Settings → Secrets and variables → Actions** and add the token as `CLOUDFLARE_API_TOKEN`. The dashboard never receives or stores this token.
5. Run the repository's **Provision adopter installation** workflow. It shows the proposed installation slug and resources before creating anything, then links the resulting Pages URL back to the dashboard setup.

## Safety checks

- The workflow accepts a new installation slug only; it rejects existing installation IDs and resource identifiers.
- Generated secrets are stored in the adopter's deployment environment, never committed to Git.
- The Actions log must redact token values and show only resource names generated from the chosen slug.
- If a user revokes the token, provisioning stops without modifying a different account.

The current source implementation remains dry-run only. A production workflow will make the same checks before it can create cloud resources.
