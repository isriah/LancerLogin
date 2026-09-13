# Postdeployment health verification

WU-173 provides the concrete read-only health adapter for the independent updater.
It consumes [WU-171's encrypted artifact/operation store](UPDATER-CLOUDFLARE-CODE.md)
and the real signed release verifier. This is local implementation with synthetic
HTTP evidence, not a claim that an updater deployment has passed hosted acceptance.

## Composition and resource authority

`createPostDeploymentHealth` closes over the pinned installation, Cloudflare account,
Worker, Pages project/production branch, application D1, API origin and dashboard
origin. Bootstrap provides a read-only Cloudflare credential, the separate updater
store and `readTrustedState`. Origin pins must be HTTPS origins with no credentials,
path or query. Per-call arguments contain only installation/operation identity and
an opaque release handle verified by this instance. Unknown fields, wrong resources
and serialized/forged handles fail before fetch. No request may supply a URL, SQL,
binding, credential or trust key.

`readTrustedState` must read the current updater-owned engine job and installed
schema/ledger, returning `healthOperationId`, `apiOperationId`, `pagesOperationId`,
`mode`, `schema` and `ledger`. The health operation ID must be the engine's current
durably claimed operation. The two deployment IDs select the **completed code
operations of this job**, including recovery jobs. Their encrypted WU-171 receipts
must match the signed target digest and provider identities. The callback must not
use browser-supplied state or the application's own version response.

`createHealthAdapters` provides `health`, `continueOperation` and `reconcile` for
engine composition. Merge it after code adapters, supplying those code adapters as
`fallback`; other kinds are forwarded, while health continuations and reconciliation
repeat only read-only provider checks. `resolveRelease` rehydrates the current
signed engine/checkpoint record through `health.verifyRelease`. No engine/status
schema change is needed.

## What is actually checked

Health is a bounded sequence, with progress in encrypted updater operation state:

1. Compare actual current Worker deployment/version and canonical production Pages
   deployment to retained definitive receipts, exact operation/digest annotations,
   signed source commit and production branch. Worker traffic must be entirely on
   the expected version; Pages must show a successful deploy stage.
2. Download the actual Worker module through the authenticated content API and verify
   its exact length/SHA-256 against the signed API artifact. Unknown extra modules
   fail; this contract supports the bundled single-module API.
3. Read the pinned API `/health` and dashboard `/api/health`, requiring `ok: true`,
   `service: 'lancerlogin-api'`, `mode: 'ready'` and the signed `releaseVersion`.
   The proxy path follows `scripts/prepare-pages-proxy.mjs`, which removes `/api`
   before forwarding. The WU-171 release-version binding correction is required;
   a stale environment value is correctly rejected.
4. Execute exactly `SELECT name FROM d1_migrations ORDER BY id` against the pinned
   application D1. Reject missing, extra, reordered or changed migration names.
5. Reverify the staged signed dashboard tar and fetch one public file per advance
   from the pinned dashboard origin. Compare actual response length and SHA-256 to
   the signed archive entry. This checks all public files, including the index and
   its referenced assets. `index.html` is fetched through `/`; redirects are rejected.
6. Recheck provider deployment identities, both health responses and the native
   migration ledger immediately before returning the final receipt. A deployment
   change during the scan cannot produce success from mixed old/new evidence.

The native D1 migration ledger records names, **not SQL hashes**. Health compares
those observed names to the updater-owned digest ledger, and checks that ledger's
prefix against the signed migration chain. It reports the observed matching ledger
length as schema; it never infers schema from the API version. This proves migration
bookkeeping matches, not that every application table/trigger/row is semantically
correct. Migration/backup acceptance remains independently required.

For normal updates, observed schema must equal the target schema. Code-only recovery
intentionally retains newer schema/ledger while running prior compatible code.
Health instead verifies that retained updater ledger, the prior signed chain's
prefix and the prior API's schema range. The receipt reports the retained schema,
not the older manifest's target schema. Restores similarly use the authoritative
post-restore updater ledger.

`_worker.js`, `_headers`, `_redirects` and `_routes.json` are nonpublic deployment
parts. Health does not pretend to download those bytes from the public site. Their
identity comes from the verified upload, retained deployment receipt and exact
current provider marker; the live proxy check establishes the API forwarding
behavior. It does not exercise every possible redirect/header/proxy route.

## Bounds, failures and remaining acceptance

All requests reject redirects and use cache bypass, a 15-second abort budget and
streaming body limits: 256 KiB for JSON, 17 MiB for Worker multipart content, and
the signed public file length plus one byte for an asset. The Cloudflare token is
sent only to `api.cloudflare.com`; API/dashboard reads carry no deployment token.
The only provider POST is the fixed read-only D1 query. Progress writes are confined
to updater D1. One step checks at most one public asset; final confirmation uses
six bounded provider/site reads. Large tar/hash/decryption CPU remains subject to
the hosted resource acceptance gate documented in WU-171.

Unavailable HTTP or unreadable responses return `unknown`; retry/reconciliation
is safe because it performs no external mutation. Verified mismatches return a
terminal failure with fixed codes such as `health-api-version`,
`health-migration-ledger-mismatch`, `health-dashboard-asset` or
`health-pages-deployment`. The encrypted operation retains the reason without
capturing body content, credentials or SQL results. A successful receipt records
the signed digest/version, observed schema, trusted ledger digest, deployment
identities and public-file count. It describes the completed check, not continuous
monitoring or an atomic snapshot across Cloudflare services.

Run `node --test tests/updater-health.test.mjs` for the focused evidence. Tests use
real SQLite migration rows and encrypted operation/artifact storage, ephemeral
signatures and realistic synthetic Fetch responses. They cover actual byte checks,
direct/proxy version checks, native ledger mismatch, asset tampering, deployment
changes during a scan, unknown-read continuation, forged contexts and code-only
recovery against a newer retained schema. No live provider calls occur.

Remaining work includes runtime composition with the authenticated service,
authoritative installed/deployed-state bootstrap, backup/migration/write-quiescence
transport, independent recovery controls, storage/key custody and hosted upgrade/
interruption/recovery/resource-limit acceptance. This unit creates no resources,
changes no application migration, and leaves production and the Pi untouched.
