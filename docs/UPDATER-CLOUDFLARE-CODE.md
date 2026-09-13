# Updater code deployment and independent artifact storage

WU-171 provides actual portable Fetch implementations for the Cloudflare Worker
and Pages code paths, and encrypted chunked storage in updater D1. It is a local
implementation milestone, not a hosted updater acceptance result. Dependencies:
[WU-168 signed bundles](APPLICATION-RELEASE-BUNDLES.md),
[WU-169 engine](UPDATER-RUNTIME.md), separately authorized resource/key bootstrap,
and WU-170 immutable release-source resolution.

## API and trust boundary

`createCloudflareCodeTransport` closes over installation/account/Worker/Pages/D1
pins, production branch, exact nonsecret Worker bindings, preserved Worker settings,
the deployment token, the real release verifier and an independent artifact store.
It exposes `verifyRelease`, `stage`, `readStaged`, `capturePrior`, `deployApi`,
`deployPages` and `reconcile`. Only locally verified opaque release handles are
accepted; serializing a handle cannot confer trust. Per-call arguments are exact
allowlists, with installation and operation identity checks before fetch. No call
accepts another resource, source URL, command, binding or credential.

Every fetch uses the fixed `api.cloudflare.com` origin, manual redirect handling
(redirects rejected), a 20-second abort budget and streaming response bounds:
1 MiB for JSON, 17 MiB for Worker code multipart readback. Provider URLs and response
bodies are not persisted or echoed in errors. The provider token goes only to the
fixed API; Pages asset uploads use the project's separate short-lived upload token.
Tokens are never put in operation receipts or application state.

Provider facts were checked against the current official
[Worker upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
and [Pages direct deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/),
and the locally pinned Wrangler **4.127.1** implementation of Pages assets and Worker
content readback. This code does not execute Wrangler or rebuild releases.

Worker upload sends the verified module, all explicitly pinned nonsecret bindings,
preserved settings and `keep_bindings: ['secret_text', 'secret_key']`. It retains
existing Worker assets and does not perform Durable Object migrations. Current
binding/configuration drift rejects the operation. Secret binding **names/types**
are checked after deployment. `keep_bindings` preserves existing provider secrets;
the provider generally cannot return their values. Captured settings are an
inventory/configuration checkpoint, **not a recoverable secret-value backup**.
Bootstrap must separately retain protected secret custody for restoration after
resource deletion or secret replacement. No code here claims to recover missing
secret values from D1 or provider settings.

`RELEASE_VERSION` is the single release-dependent nonsecret binding. Bootstrap
must pin its name/type. Before API dispatch the current value must exactly match
the verified `priorRelease` handle; upload derives the new value exclusively from
the verified target manifest, and reconciliation checks that exact target value.
Every other nonsecret binding remains pinned. This keeps API `/health` truthful
across upgrades and code rollback without accepting request-supplied version text.

Worker reconciliation requires the exact operation/digest version annotation and
that version alone receiving 100% of the current deployment, then rereads preserved
settings/secret inventory. Pages reconciliation requires the exact operation/digest
commit message, source commit and pinned production branch, successful deploy stage
and current canonical production deployment. Lookups are bounded to the current
100 versions/deployments; missing or contradictory evidence remains unknown.

## Durable bounded continuation

`stage` stores one 96 KiB encrypted chunk per call, then seals the complete verified
artifact on a subsequent call. Pages deployment first checkpoints its production
configuration digest, then uploads **one static asset per call**, followed by one
multipart deployment. `_worker.js`, `_headers`, `_redirects` and `_routes.json` are
sent as supported deployment parts, not public asset-cache entries. Pages environment
variables/configuration are not overwritten. Existing production configuration is
checked before each substep and after deployment. Only direct-upload projects with
the pinned production branch are accepted; a Git-backed project is not silently
switched or built.

Pages asset keys follow Wrangler's BLAKE3 of base64 bytes plus extension, truncated
to 128 bits. The portable implementation has trusted empty-input and multi-chunk
Wrangler vectors. This hash is a provider cache address; signed SHA-256 remains
the release-integrity authority. After an upload acknowledgment is lost, read-only
`check-missing` for that exact hash can establish presence; an absent key never
authorizes another uncertain upload.

Updater D1 records each operation's exact release digest and substep before a
provider mutation, using revision compare-and-swap. Losing callers cannot dispatch.
Worker/Pages deployment acknowledgments that are missing, malformed or rejected
without authoritative reconciliation remain `unknown`; there is no blind deployment
retry. A definitive completed substep can return `{outcome:'pending'}`. The engine
retains the same parent operation and invokes `continueOperation` on a later explicit
advance. Unknown operations continue through **read-only reconciliation**; only
positive readback establishing safe continuation can change them back to pending.
No pending outcome is reported as an installed release or completed deployment.

`createCloudflareCodeAdapters` provides engine glue for stage/read/capture/deploy/
reconcile/continuation. Its two trusted release resolvers reverify the engine's
current signed record or retained prior signed record through this transport.
`resolveInstalledRelease` must read updater-owned prior state, not the target
release or an application version assertion. The ordinary source adapter still
provides `readManifest`/`readArtifact`; backup, migrations and real health adapters
remain separate. Recovery reads staged prior bytes without needing GitHub or the
application to be available.

The additional required `resolveDeployedRelease` resolver supplies the signed
currently deployed API release from retained definitive deployment receipts/state.
It must never infer this from the app's reported version. After an interrupted
upgrade the deployed candidate may differ from the engine's not-yet-committed
installed version; recovery must provide that candidate as `priorRelease` while
the rollback target is the captured prior release. There is intentionally no
fallback to the installed resolver that would hide this recovery requirement.

## Storage and prior-code capture

`apps/updater/state/0002_updater_artifacts.sql` applies **only to updater-state D1**.
It adds immutable artifact metadata/chunks and encrypted provider operation records.
It is not application migration 50 and is not included in application backups.
Artifact IDs bind signed manifest digest and basename. Each immutable chunk has a
SHA-256 commitment and AES-GCM envelope bound to installation, artifact ID, index
and digest; whole-byte length/hash must match before sealing. Reads verify every
chunk and the full signed digest. Raw code/configuration is not stored unencrypted.
Individual rows remain under 180 KiB for the selected chunk size.

Readback uses pages of 16 chunks: a maximum 16 MiB artifact has 171 chunks, requiring
11 page queries plus one metadata query. This leaves room for both the engine's
verification read and transport verification read plus claim/authentication work.
The focused maximum-size test counts the actual combined engine/transport path and
requires at most 40 D1 queries before service authentication. The outer service must
retain the remaining query budget. No retention/deletion scheduler is implemented;
bootstrap/operators must allocate capacity and retain all active recovery artifacts
until a separately reviewed retention policy is implemented.

`capturePrior` reads the active Worker version, its actual module bytes and current
settings, verifies code against the prior signed release and retains it independently.
The previous signed Pages archive must already be staged by bootstrap or the prior
update; provider deployment metadata must identify that exact signed release.
Capture rereads Worker/Pages deployment identities and Pages configuration to detect
drift. A historical unsigned deployment must go through explicit signed-state
bootstrap acceptance; a matching version label alone is insufficient. Capture
supports the bundled single-module API artifact; unknown additional modules fail.

## Local evidence and remaining acceptance

Run `node --test tests/updater-cloudflare-code.test.mjs tests/updater-engine.test.mjs`.
Focused tests use real SQLite, AES-GCM, signatures, tar validation and the actual
Fetch transport against realistic synthetic responses. They cover encrypted chunk
reconstruction/tamper detection, rejected forged/resource contexts before network,
secret-binding preservation metadata, one Worker upload after lost acknowledgment,
one Pages asset upload and deployment after lost acknowledgments, engine pending
continuation, captured-code readback and the 16 MiB archive query budget. Synthetic
backup/health seams in the integration test are explicitly test fixtures, not
production backup/health implementations.

**Hosted CPU/memory limits remain unverified.** Base64 conversion, portable BLAKE3,
tar parsing and repeated decryption/hash verification of large artifacts may exceed
Free-plan CPU limits despite staying within the D1 call bound. The maximum-size
local test is not proof of hosted Free compatibility. Actual API/Pages deployment,
binding/secret preservation and max-size runtime acceptance require separately
authorized hosted drills. No cloud resources or credentials were changed here.

Remaining P6 requirements include resource/key/bootstrap custody, backup/migration/
write-quiescence transport, actual health/version verification, independent recovery
authentication/UI, signed updater upgrades, storage retention and all hosted upgrade
and recovery drills. P4 document-compute acceptance remains independently outstanding.
