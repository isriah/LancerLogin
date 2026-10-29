# Cloudflare linking

LancerLogin is installed in the adopter's own Cloudflare account with an account-owned API token. Follow the step-by-step instructions on the documentation site: [Create the Cloudflare API token](https://isriah.github.io/LancerLogin/setup.html#cloudflare-token).

## Token policy

Create the token from scratch under **Manage account > Account API tokens**, scoped to the single selected account (**Entire Account**), with exactly these permissions:

| Permission group | Access | Review page shows | Purpose |
| --- | --- | --- | --- |
| Workers Scripts (labelled "Legacy" by Cloudflare) | Edit | Workers Scripts Write | Deploy the API Worker |
| D1 | Edit | D1 Write | Create the database and apply migrations |
| Pages | Edit | Pages Write | Create and deploy the dashboard |
| Account Settings | Read | Account Settings Read | Verify that the token belongs to the selected account |

Account-owned token values start with `cfat_`. The installation uses the default Pages and Workers URLs, so the token needs no zone, DNS, billing, member or user-management permission.

## Secrets

Store the values as `production` environment secrets in the private deployment repository:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token value, not its Cloudflare name |
| `CLOUDFLARE_ACCOUNT_ID` | The 32-character account ID, not a zone ID |

The workflow calls Cloudflare's account token verification endpoint for the exact account before it creates or changes anything. Keep account IDs, tokens, private URLs and resource IDs out of public documentation and repository commits. Replace the secret before the token expires; a rejected token stops the next run before any change.
