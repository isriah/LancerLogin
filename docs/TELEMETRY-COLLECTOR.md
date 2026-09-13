# Community telemetry collector

This reference is for maintainers of the optional community collector. It is not deployed for an adopter, is not part of the adopter provisioning workflow, and must never share a Cloudflare account, D1 database, Worker, token, secret, or deployment path with an attendance installation.

## Data boundary

The public `/v1/report` route accepts only an opaque UUID installation ID, release version, active kiosk count (`0` or `1`), one scrubbed diagnostic category, and optional city or metro. Unknown fields and IP-shaped location values are rejected. The raw UUID is HMAC-hashed with a collector-only secret before storage. Worker observability is disabled in generated configuration.

The collector stores at most one report per installation per UTC day. Its aggregate endpoint requires a separate bearer token, never returns installation hashes, and suppresses metro groups smaller than five installations. A scheduled cleanup deletes reports older than 30 days and then removes orphaned hashes. The authenticated deletion route hashes one supplied opaque reference in memory and deletes matching data.

## Deployment boundary

Use a fresh collector-only Cloudflare account and dedicated account-owned API token. The current Cloudflare [account-token guide](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) describes account tokens as durable service credentials and requires Super Administrator access to create or update them. Scope the token only to the collector's deployment needs.

The reviewed path is the manual **Deploy community telemetry collector** action in the protected `telemetry-production` environment. Keep the Cloudflare token, account ID, HMAC key, and aggregate administrator credential as protected environment secrets. Never display, commit, reuse, or include them in a fixture. Verify `/health`, use only a synthetic UUID payload for a test report, and verify cleanup in a test database before approving a production deployment.

The adopter deployment configures the endpoint internally. If an Administrator opts out of anonymous usage reporting, the installation sends no collector report. See [TELEMETRY-GOVERNANCE.md](TELEMETRY-GOVERNANCE.md) for the public policy.
