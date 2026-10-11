# Link the Cloudflare account

This guide is for the Administrator creating a new private deployment repository. It uses an account-owned API token in the adopter's own Cloudflare account. Cloudflare's current [account token guide](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) calls the path **Manage Account → Account API Tokens** and requires Super Administrator access to create or update a token.

## Create the token

1. In the private repository, create the `production` environment under **Settings → Environments**.
2. In Cloudflare, select the adopter-owned account. Open **Manage Account → Account API Tokens → Create Token**.
3. Give the token a human-readable name, then use a custom policy. Limit it to the selected account and grant only:
   - **Workers Scripts**: Edit
   - **D1**: Edit
   - **Pages**: Edit
   - **Account Settings**: Read
   Account Settings Read permits the workflow to verify the selected account.
4. Review the policy, create the token, and copy its value immediately. Cloudflare shows the value once. Do not screenshot or record the reveal screen.
5. Use Cloudflare's current account-ID control to copy the selected account's ID. Confirm it is the account ID, not a zone ID.

The installation uses default Pages and Workers URLs. Do not add zone, DNS, billing, member, or user-management permissions.

## Store deployment secrets

In the private repository's `production` environment, add these **environment secrets**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The copied token value, not its Cloudflare label |
| `CLOUDFLARE_ACCOUNT_ID` | The selected account ID |
| `LANCERLOGIN_SETUP_CODE` | A unique password-manager-generated value of at least 16 characters |

Use secrets, not variables. The setup code protects first-Admin creation and is not an Administrator password.

Before initial provisioning, configure the private web-update credential and the required installation variables described in [WEB-UPDATES.md](WEB-UPDATES.md). Keep account IDs, tokens, private URLs, and resource IDs out of public documentation and repository commits.

## Expected result

Run **Install or upgrade LancerLogin** in the private repository with `create` and **Latest stable**. The workflow verifies the selected account and token, creates the adopter-named resources, and reports the dashboard URL. If it reports a token, account, or collision error, correct that private-environment configuration and rerun only after confirming the intended account.
