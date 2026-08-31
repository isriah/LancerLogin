# Community telemetry collector

The collector is an isolated, optional maintainer service. It is **not** deployed by an adopter, is not part of the adopter provisioning workflow, and must never share an account, D1 database, Worker, token, or secret with another attendance installation. This repository has not deployed it anywhere.

## Privacy and integrity boundary

The public ingestion route accepts exactly five fields: an opaque UUID install ID, release version, active kiosk count (`0` or `1`), one scrubbed diagnostic category, and optional city/metro text. Unknown fields are rejected. IP-shaped metro values are rejected, request headers are never read, Worker observability is disabled in the generated configuration, and the raw install UUID is HMAC-hashed with a private collector pepper before storage.

The collector writes at most one row per installation per UTC day. Global and per-installation Cloudflare rate-limit bindings constrain bursts without using source IPs as application keys. A configurable daily-new-installation ceiling bounds storage growth. These controls reduce abuse but do not make anonymous community telemetry authoritative; reported counts remain best-effort signals.

The aggregate endpoint requires a long bearer token. It never returns installation hashes. Metro rows appear only when at least five distinct installations report the same value. A scheduled cleanup removes reports older than 30 days and then removes orphaned hashes. The authenticated deletion route accepts only one opaque install reference, hashes it in memory, and deletes matching reports and the pseudonymous installation row. The approved public policy is in `docs/TELEMETRY-GOVERNANCE.md`.

## Account-neutral deployment preparation

Use a fresh collector-only Cloudflare account and dedicated account-owned API token. Account-owned tokens are designed for durable CI/CD integrations. The operator needs Account Settings read, Workers Scripts write, D1 write, and permission to configure Worker rate limits. Use Wrangler 4.36.0 or newer.

The recommended path is the manual **Deploy community telemetry collector** GitHub Action. In the protected `telemetry-production` environment, store the dedicated Cloudflare token as `LANCERLOGIN_TELEMETRY_CLOUDFLARE_API_TOKEN`, the selected account ID as `LANCERLOGIN_TELEMETRY_CLOUDFLARE_ACCOUNT_ID`, an independently generated 48-byte base64url HMAC key as `LANCERLOGIN_TELEMETRY_INSTALL_PEPPER`, and an independently generated 48-byte base64url administrator credential as `LANCERLOGIN_TELEMETRY_ADMIN_TOKEN`. Never display or reuse the credentials. The account ID is kept in the environment so the workflow can verify the exact target instead of listing or guessing accounts. The Create operation refuses an existing database or Worker with the reserved name, applies migrations, verifies `/health`, submits and deletes a synthetic report, and reports the public endpoint. Resume requires the dedicated database to exist and does not rotate existing Worker secrets. Keeping the administrator credential in the protected GitHub environment permits approved maintainers to perform aggregate and verified-deletion operations without exposing it.

1. Put a narrowly scoped token in `CLOUDFLARE_API_TOKEN` for the current shell only.
2. List D1 resources into a temporary JSON file and run `node scripts/prepare-telemetry-collector.mjs <d1-list.json>`. The generator writes an owner-only `.collector/wrangler.json` and reports `missing` until the dedicated `lancerlogin-community-telemetry` database exists.
3. If the default rate-limit namespace IDs conflict with another Worker in that account, pass two different positive integers after the list path.
4. Create only the dedicated D1 database, regenerate the config, and apply `apps/telemetry-collector/migrations` using that generated config.
5. Generate independent random base64url values of at least 32 characters for the `INSTALL_ID_PEPPER` and `ADMIN_BEARER_TOKEN` Worker secrets. Never commit, display, or reuse them.
6. Deploy from the generated configuration, verify `/health`, send only a mock UUID payload, inspect the authenticated aggregate response, and verify scheduled deletion in a test database before approving production use.

Do not add `TELEMETRY_ENDPOINT` to the adopter release template until the first fresh deployment succeeds and its HTTPS URL is reviewed. Accepted telemetry remains a safe no-op without that value, and attendance is never dependent on collector availability.
