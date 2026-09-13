# Private installed-release bootstrap preflight

WU200 adds a private, resumable prerequisite to `createUpdaterRuntime().initialize`. It introduces no HTTP initialization route, resource provisioning, deployment mutation, or environment configuration. Runtime callers still require the constructor-owned bootstrap capability. Application/control/recovery requests cannot supply adoption authority.

## Trusted input and prerequisite

The existing signed `releaseId`, exact manifest/signature bytes, updater version and artifact Map now accompany `adoption` with exactly these fields:

- `contract: exclusive-installed-release-adoption-v1` and a 64-character SHA-256 `recordSha256` identifying an operator-reviewed adoption record.
- `installationId`, `accountId`, `applicationDatabaseId`, `worker`, `pagesProject`, `productionBranch`, matching fixed runtime pins.
- `apiDeploymentId`, `apiVersionId`, `pagesDeploymentId`, identifying the installed production deployments.
- `secretBindings`, the exact API secret name/type inventory, never secret values.
- `pagesWorkerSha256`, the signed dashboard archive `_worker.js` digest.
- `pagesConfigurationSha256`, canonical SHA-256 of `bootstrapPagesConfiguration(productionConfiguration)`.

The private adopter must establish exclusive ownership of schema/deployment/config changes throughout this process and independently establish that the deployed Pages worker is the exact signed archive worker. The opaque adoption record digest identifies that evidence; it is not a cryptographic proof of the premise. Public assets, a release signature, Pages metadata and API code equality cannot establish Pages worker provenance or exclusive ownership. No hosted adoption has been performed by this unit.

The Pages projection permits a fixed set of production configuration fields: compatibility date/flags, environment variables, D1, Durable Object, KV, R2, service, Analytics Engine, AI, Vectorize, Hyperdrive binding metadata, placement, usage model and build image version. Unknown top-level fields fail closed. Secret environment variables retain only type; plain variables retain type/value. The private operator must provide only the provider's noncredential resource metadata in other permitted binding fields. Tokens and provider response bodies are never persisted; only digests and authenticated public-file descriptors are retained. Current Pages readback also requires production branch/source commit and release digest annotation, successful direct production deployment and no source-linked build.

## Durable ordering and fresh checks

The complete adoption tuple, fixed runtime pins, compiled catalog and signed manifest digest bind the encrypted bootstrap identity. Only compiled schema46/schema49 initial installations are accepted, with the exact signed migration chain. Actual primary `sqlite_schema` objects and ordered native migration names must match the selected catalog, including operational tables and the native ledger. Snapshot-supplied schema SQL is never accepted.

After existing bounded artifact staging, preflight progresses through encrypted claim, API proof, archive proof and public-asset phases. API proof checks the active deployment/version, exact known settings/nonsecret bindings and secret inventory, verifies downloaded API bytes against the signed artifact, and rechecks deployment/config identity. The archive proof verifies the retained signed archive and Pages worker digest and writes at most eight encrypted pages of 256 file descriptors, each limited to 64 KiB. Descriptor hashes derive only from authenticated archive bytes. Each later public-asset continuation reads one descriptor page and fetches one fixed-origin asset. Public fetches never receive the provider bearer; all fetches disallow redirects and bound response bytes, with a 15-second deadline per request. API preparation uses at most eight provider reads; no provider writes occur.

A ready record never replaces the final live proof. Immediately before the first engine initialization and again before the bootstrap completion marker, runtime rechecks actual schema/native ledger and current API/Pages deployment/config identity. A lost engine-write acknowledgment leaves routing unavailable until a retry passes the completion proof. Completed bootstrap replay returns its prior result without rechecking a later updated application, resetting engine state, or admitting a new installation. Identity mismatch still rejects.

## Bounds and limitations

The signed archive limits remain 16 MiB and 2,048 files. A maximum archive is read/decrypted once per successful archive-proof phase, rather than once per asset. A lost archive-proof acknowledgment can repeat that bounded read, with exact immutable descriptor page comparison. Hosted CPU/memory and provider latency remain unmeasured; this local fixture establishes request counts, not hosted execution acceptance. The private caller must continue pending initialization; no scheduler, timeout takeover or automatic adoption permission is added.

Focused verification: `node --test tests/updater-bootstrap-preflight.test.mjs tests/updater-entrypoint.test.mjs`. Fixtures contain synthetic signing keys, actual reviewed SQLite schemas and synthetic provider responses. Tests cover signed-code tamper, unknown live schema, adoption identity conflict, fresh configuration rejection, lost initialization acknowledgment, completed replay, secret projection and maximum archive descriptor cost. Existing runtime scenarios now explicitly supply the same private adoption contract; the existing no-public-bootstrap routing tests remain in force.

Candidate evidence: small signed schema49 bootstrap peaked at 17 D1 statements and 8 read-only Fetch calls (separate categories). The exact 16 MiB, 2,048-file fixture peaked at 26 D1 statements during preparation; subsequent asset checks used 7 D1 statements and one public Fetch with zero archive chunk rereads. The maximum case passed in 65.299 seconds locally. These measurements exclude any operator-side driver overhead. The compiled initialized Worker routing test passed in 21.467 seconds after the known esbuild sandbox path denial was retried locally outside the sandbox. The existing schema49 backup/failed-health/recovery/reopening scenario passed in 21.766 seconds. No hosted resources were contacted.
