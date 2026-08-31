# Community telemetry collector

The collector is an isolated, optional maintainer service. It is **not** deployed by an adopter, is not part of the adopter provisioning workflow, and must never share an account, D1 database, Worker, token, or secret with another attendance installation. This repository has not deployed it anywhere.

## Privacy and integrity boundary

The public ingestion route accepts exactly five fields: an opaque UUID install ID, release version, active kiosk count (`0` or `1`), one scrubbed diagnostic category, and optional city/metro text. Unknown fields are rejected. IP-shaped metro values are rejected, request headers are never read, Worker observability is disabled in the generated configuration, and the raw install UUID is HMAC-hashed with a private collector pepper before storage.

The collector writes at most one row per installation per UTC day. Global and per-installation Cloudflare rate-limit bindings constrain bursts without using source IPs as application keys. A configurable daily-new-installation ceiling bounds storage growth. These controls reduce abuse but do not make anonymous community telemetry authoritative; reported counts remain best-effort signals.

The aggregate endpoint requires a long bearer token. It never returns installation hashes. Metro rows appear only when at least five distinct installations report the same value. A scheduled cleanup removes reports older than `RETENTION_DAYS` and then removes orphaned hashes. The generated default is 30 days, but the public operator must choose and publish the final retention period before configuring an endpoint.

## Account-neutral deployment preparation

Use a fresh collector-only Cloudflare account or explicitly isolated collector-only resources. The operator needs Account Settings read, Workers Scripts edit, D1 edit, and permission to configure Worker rate limits. Use Wrangler 4.36.0 or newer.

1. Put a narrowly scoped token in `CLOUDFLARE_API_TOKEN` for the current shell only.
2. List D1 resources into a temporary JSON file and run `node scripts/prepare-telemetry-collector.mjs <d1-list.json>`. The generator writes an owner-only `.collector/wrangler.json` and reports `missing` until the dedicated `lancerlogin-community-telemetry` database exists.
3. If the default rate-limit namespace IDs conflict with another Worker in that account, pass two different positive integers after the list path.
4. Create only the dedicated D1 database, regenerate the config, and apply `apps/telemetry-collector/migrations` using that generated config.
5. Generate independent random base64url values of at least 32 characters for the `INSTALL_ID_PEPPER` and `ADMIN_BEARER_TOKEN` Worker secrets. Never commit, display, or reuse them.
6. Deploy from the generated configuration, verify `/health`, send only a mock UUID payload, inspect the authenticated aggregate response, and verify scheduled deletion in a test database before approving production use.

Do not add `TELEMETRY_ENDPOINT` to the adopter release template until the operator, HTTPS URL, retention period, access policy, incident contact, and deletion process have been reviewed and published. Accepted telemetry remains a safe no-op without that value, and attendance is never dependent on collector availability.
