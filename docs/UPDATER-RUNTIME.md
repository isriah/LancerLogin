# Independent updater runtime

WU-169 implements the durable engine for P6. It is a local implementation milestone,
not a deployed updater or completed in-app upgrade flow. Dependencies: WU-168's
[signed application release contract](APPLICATION-RELEASE-BUNDLES.md), separately
provisioned updater storage and keys, and the provider/service transports below.
Hosted P4 document-compute acceptance remains outstanding independently of this work.

## Installation boundary

`apps/updater/state/0001_updater_state.sql` belongs exclusively to the updater-state
D1 database. It must never be placed in the application's migration chain or
portable backup. `createUpdaterStore` uses a singleton row with an installation
pin and revision compare-and-swap. No application database binding can substitute
for this independently provisioned binding. Signed releases cannot change it.

The engine owns installed version, schema, migration ID/digest ledger, updater
version and highest accepted release sequence. Trusted bootstrap initializes these
once from a verified installed release and independently observed migration ledger;
bootstrap must verify actual provider deployments/schema before calling initialize.
The engine does not infer installed state from an application-reported version.
Concurrent admissions cannot both acquire the row. The sequence increases at
admission and is never reduced by a failed update or recovery.

Construct the engine with the production `createApplicationVerifier(pins)` and
`readDashboard` from `packages/shared/src/updater/`. The verifier's pins originate
in updater bootstrap. `readDashboard` must be the strict archive parser, not an
unchecked extraction callback. Staging and deployment reverify artifact bytes;
every advancement reverifies the persisted manifest signature. Artifacts never
enter the singleton JSON: adapters store bytes outside that row under the verified
manifest digest and artifact name. The state row has a 1.5 MB serialization cap;
the independent encrypted checkpoint has a 256 KiB plaintext cap. Signed manifests
remain bounded by the shared verifier's 128 KiB limit.

All entry points require the exact in-memory capability supplied to the factory.
This rejects a serialized `{ role: 'admin' }` assertion; it is **not** a replacement
for transport authentication. A trusted service/recovery transport must authenticate
the caller, reload current Admin authority, enforce installation/audience/replay
boundaries and explicit restoration confirmation, then supply the capability.
It must not return the capability to the browser or grant it merely because the
request carries a role field. Initial bootstrap needs its own authorization path.

Update requests contain only a positive numeric immutable `releaseId` and opaque
`requestId`. Recovery requests contain only `failedJobId`, `mode` (`code-recovery`
or `restore`) and `requestId`. Unknown fields are rejected. There are no accepted
URLs, repositories, resources, bindings, SQL, shell commands, credentials or trust
replacements. Retries of the current request identity return its existing job;
changing its target with the same identity is rejected. Status returns bounded
progress and fixed failure codes, never manifest signatures, retained configuration
or ciphertext.

## Bounded progression and ambiguous operations

One `advance` call performs one adapter operation, or one read-only reconciliation.
The update order is individual artifact staging, prior-code/config capture, verified
backup, individual pending migrations, API deployment, Pages deployment and health.
The engine admits only releases whose prior API accepts the target schema and whose
prior frontend accepts the new API protocol. It rejects `maintenance-required`
before provider mutation for other releases. This is a deliberate current boundary:
explicit maintenance orchestration remains a required P6 feature.

Before dispatch, an atomic revision claim records a random external operation ID.
A caller losing the claim cannot dispatch. The operation has no expiring mutation
lease. A later caller or replacement process seeing the record can only reconcile;
it cannot issue the original mutation again. This includes a crash between recording
the intent and sending the provider request. Such an operation may remain unresolved
until independent evidence establishes its fate. Empty lookup, timeout, malformed
receipt, generic exception or process restart are **not** proof of rejection.

Adapter outcomes are:

- `{ outcome: 'applied', receipt }`: authoritative success bound to the exact
  operation identity and expected resource. The engine checks the step-specific
  receipt before advancing its ledger/checkpoint.
- `{ outcome: 'failed', terminal: true }`: authoritative terminal rejection/failure,
  with no ambiguous in-flight effect. For migrations, this additionally requires
  proof that the failed step did not advance or partially alter the schema. A
  provider error alone does not establish transactional rollback.
- `{ outcome: 'unknown' }`: retain the durable operation and reconcile only.

Adapters must not turn zero marker matches into terminal failure. Only identity-bound
positive readback or definite rejection can clear ambiguity. A delayed original
caller may finish after another caller reconciles; its obsolete result cannot advance
another step. Completed operation IDs remain with the current durable job. There is
no automatic retry loop and no concurrent update while a job is running, ambiguous
or failed. A confirmed terminal `stageArtifact`, `captureCheckpoint` or `backup`
failure exposes `retryPreparationOperationId` in status. An authorized explicit
`retryPreparation({jobId,failedOperationId})` resumes that same release and step
with a new dispatch identity, preserving the high-water sequence and installed
ledger. Replaying this request cannot clear a later operation. It cannot retry
migration/deployment failures or unknown operations, nor change the release target.

## Recovery checkpoint

Before application mutations, the checkpoint records the prior verified release,
installed ledger/version, code-rollback classification, retained code/configuration
metadata and subsequently the verified backup identity/digest. AES-256-GCM uses a
random 96-bit IV and an updater-only 32-byte key. Installation and original job ID
are authenticated associated data; moving an envelope to a different job fails.
Sensitive configuration is encrypted, including when retained for later recovery.
Actual code/backup bytes need independent durable storage, not application D1 or a
temporary process buffer. The checkpoint is tied to the job that captured it; an
older successful update's checkpoint cannot recover a newer failed preparation.

Only a definitively failed job with a verified backup can start recovery. A pending
operation must first be reconciled; starting recovery cannot race an original
deployment still in flight. Recovery loads the captured prior code, not a fresh
download from GitHub. Code-only recovery uses the shared verifier's checkpoint
rules, accepts only `compatible`, preserves the current migration ledger/schema
and high-water sequence, and deploys the prior frontend before the prior API.
This order uses the mixed-version compatibility proved at admission.

`restore` restores the exact verified backup, resets the installed schema/ledger
to that backup, redeploys prior Pages/API and checks health. It retains the high-water
sequence. The factory requires an explicit `recoveryQuiescence: true` adapter
capability before admitting restoration; this is a trusted implementation promise,
not a browser assertion. Concrete adapters must establish and durably retain app
write quiescence from before restoration through health and controlled reopening.
WU-169 has no hosted maintenance implementation and cannot make that promise for
Cloudflare. Restoration tests exercise actual separate SQLite files with no app
writers. They do not establish hosted D1 restoration or write fencing.

## Required adapter contract

Adapters close over pinned infrastructure identities and updater-only credentials.
No method may honor alternative resources from release metadata. All network bodies,
downloads and operation durations need streaming/time bounds in the transport;
the engine bounds the number of calls, not the duration of a provider request.

| Method | Required behavior |
| --- | --- |
| `readManifest({releaseId})` | Resolve the pinned immutable release/source; return raw manifest/signature bytes. No mutation. |
| `readArtifact(context)` | Read one signed descriptor from that exact immutable release with bounded download. |
| `stageArtifact(context)` | Retain the supplied verified bytes under digest/name; receipt includes `manifestSha256`, `name`, `sha256`. |
| `readStagedArtifact(context)` | Read previously staged exact bytes; engine rehashes and validates tar before use. |
| `captureCheckpoint(context)` | Read/capture prior deployment IDs and retained code/configuration in independent storage; receipt has `priorCode` and `configuration`. Never mutate the app's configuration. |
| `backup(context)` | Verify a complete recoverable application backup against the current schema/ledger before reporting `{backupId,sha256,schema,verified:true}`. Preserve actual configuration and secrets without exposing them. |
| `applyMigration(context)` | Apply only the supplied verified pending migration; atomically associate identity/digest and observed schema transition where the provider permits. Receipt includes `id`, `sha256`, `fromSchema`, `toSchema`. Ambiguous/partial application must reconcile or restore, never rerun by timeout. |
| `deployApi(context)` | Deploy only the staged verified API to the pinned Worker, preserving existing bindings/secrets. Receipt contains verified `manifestSha256` after authoritative acknowledgment. |
| `deployPages(context)` | Deploy only strictly validated staged archive entries to the pinned Pages project, preserving required configuration. Same digest receipt requirement. |
| `health(context)` | Verify actual API/dashboard version/digest and schema; receipt includes `version`, `schema`, `manifestSha256`. Recovery also verifies write reopening through its trusted transport. |
| `readRecoveryArtifact(context)` | Read captured prior code from independent storage while app/source access is unavailable. Engine verifies against the prior signed release. |
| `restoreBackup(context)` | Verify checkpoint backup identity/digest, quiesce writes, restore only pinned app D1 and preserve updater state; return that backup's identity/digest/schema. |
| `reconcile(context)` | Read-only exact-operation/provider evidence for the recorded `operationId`, kind, installation and manifest; return the same validated receipt shape or unknown. Never dispatch the mutation. |

Mutation contexts include the trusted manifest, installed state, fixed job/operation
IDs and verified bytes where needed. Some stages also receive decrypted checkpoint
metadata. Adapters must not log these contexts or provider responses. Exceptions
are replaced with fixed engine failure codes, not echoed into status.

## Focused local evidence and remaining scope

Run `node --test tests/updater-engine.test.mjs` with Node 24. Tests use the actual
production release verifier and archive parser, ephemeral signing/encryption keys,
separate real SQLite application/updater/provider databases, actual SQL migrations
and file-backed database restoration. They cover unauthorized role assertions,
signature tampering, request overrides, competing admissions, delayed dispatch
owners, process replacement, committed migration with lost acknowledgment, failed
second migration preserving the first, damaged staging, code-only recovery,
restoration with release-source access unavailable, retained sequence and encrypted
checkpoint isolation. Provider adapters are synthetic; no network calls occur.

Remaining P6 work includes pinned GitHub/Cloudflare transports, chunked independent
artifact/backup storage, installed-state bootstrap reconciliation, current Admin
service authorization, in-app availability/status/actions, independent recovery
authentication/UI, maintenance mode and hosted quiescence, signed updater upgrades,
key custody/rotation and the actual hosted signed
upgrade/interruption/failed-migration/recovery drills. This milestone neither creates
cloud resources nor changes application migrations, production or the Pi.
