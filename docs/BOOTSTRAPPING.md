# Browser-led setup design

## Adopter flow

1. Use this repository as a GitHub template in the adopter's own GitHub account.
2. In the dashboard, follow **Connect Cloudflare** to create or select the adopter's own account and generate a narrowly scoped token. [The account-linking guide](CLOUDFLARE-LINKING.md) explains this flow.
3. In GitHub, add that token as `CLOUDFLARE_API_TOKEN`, then run **Provision adopter installation**. The final workflow will create an adopter-named Worker, D1 database, Pages dashboard, deployment secrets, and initial state; it will output the Pages URL. This foundation runs only a dry-run validation.
4. Open the Pages URL and create the first Admin. Accept the privacy notice before telemetry can be enabled.
5. Complete the resumable setup checklist: branding, roster, dashboard auth, kiosk pairing, fingerprint test, test meeting, and attendance confirmation. Integrations are separate, skippable checklist items.
6. On the Pi, download one guided installer from the dashboard. It prompts for the Pages URL and a short-lived pairing code; it does not clone a repository or require manual source edits.

## Mock-first development

`provision-template.yml` intentionally cannot contact a cloud account. Local tests use fake bindings and fake integration clients. An actual provisioning workflow may be added only when a fresh adopter-specific target and secret scope are supplied; it must reject all existing installation identifiers and non-empty target configuration.

## Required first-run inputs

- organization name, optional subtitle/logo, primary/secondary colors, and mode
- one or both authentication methods
- first Admin identity or local credentials
- time zone
- consent choice for telemetry
