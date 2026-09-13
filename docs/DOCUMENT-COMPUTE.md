# Isolated document computation (WU-154)

Dependencies: WU-152 validation/modern-PDF path, pinned experiment `pdf-lib@1.17.1`, and current Admin/development bootstrap safeguards. This implements reusable private staging, asynchronous computation and result retrieval. **No resources were created or hosted faults invoked; hosted CPU/memory acceptance remains open.** Future artifact/packet consumers must attach current authorization and immutable selection snapshots. There is no general public upload adapter or automatic publication.

## Proposed resource boundary

| Resource | Fixed development identity |
| --- | --- |
| Worker | `lancerlogin-v2-example-document-compute` |
| SQLite DO class | `DocumentComputeQueue` |
| Service binding | `DOCUMENT_COMPUTE_QUEUE` |
| Migration tag | `document-compute-v1` |
| Singleton | `installation-document-compute-v1` |
| Existing API's service binding | `DOCUMENT_COMPUTE` |

Cloudflare supplies the namespace ID/name after approved creation. Local preparation does not invent it. Config disables workers.dev, preview URLs and routes, sets CPU to 30,000 ms, and supplies no cron, core DB, provider, session, integration or updater secrets. Only explicit synthetic mode adds `DOCUMENT_COMPUTE_PROOF_MODE=synthetic`; normal mode rejects every proof/fault path. The API does not import the parser/PDF library.

One fixed DO serves this installation/service: at most one active parser plus two staging/queued jobs. An in-instance guard prevents a second alarm during awaited parser work; Cloudflare also documents one alarm handler at a time per object. On replacement, persisted `running` becomes terminal `failed/EXECUTION_INTERRUPTED` without parsing that input again. A subsequent normal job may proceed. The persisted watchdog does not preempt synchronous work or authorize overlap. [Alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/)

The platform's 128 MB limit is **per isolate**, not reserved memory or a measured per-job peak. Dedicated service/serialized parsing separates resource failure from authentication, but hosted CPU/memory failure and recovery must still be demonstrated. [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## Reusable private protocol

| Method/path | Behavior |
| --- | --- |
| `POST /jobs` | Admit exact immutable manifest and reserve capacity. |
| `PUT /jobs/:id/items/:index/chunks/:index` | Sequential 256 KiB chunks, shorter final chunk; identical repeats return state, changed bytes fail. |
| `POST /jobs/:id/seal` | Empty body; verify complete digests and queue once. |
| `GET /jobs/:id` | Safe state/digests/attempts/outcomes, no input bytes or manifest text. |
| `GET /jobs/:id/result` | Complete private PDF bytes, length, output SHA-256 and manifest SHA-256. |
| `GET /jobs/:id/items/:index/original` | Completed original-item commitments, identity, type, length, digests and validation outcome; no bytes. |
| `GET /jobs/:id/items/:index/original/chunks/:index` | One verified stored original chunk, at most 256 KiB; never the generated PDF. |

The exact manifest contains `version:1`, `id`, `operation:validate-artifact|assemble-packet`, `policyVersion:document-input-v1`, `snapshotDigest` and ordered `items`. Validation has one item. Each item contains opaque `id`, immutable `revision`, ASCII `caption`, approved HTTPS `url`, `type`, `byteLength`, original `sha256`, and PDF-only unique `selectedPages`. URLs are selected links, never fetched. The trusted caller owns transport/provider authorization, current revisions and the complete snapshot represented by `snapshotDigest`.

Ordinary IDs are `<13-digit-issuedAt-ms>-<UUIDv4>`. Timestamps over one second ahead or at least 24 hours old are rejected. Expiry is issuance plus 24 hours, never extended by retry. Ordinary bytes/metadata are removed after expiry; the expired ID remains inadmissible through its encoded timestamp. New work needs an explicit new ID. Uncertain writes are read back using the original ID; the proof adapter never retries/replaces a mutation automatically. Status may await housekeeping, but result bytes are denied immediately at expiry.

Limits: 128 retained records including permanent proof tombstones, 256 KiB metadata, three live jobs, 84 MiB total byte reservation, 4 MiB/file, 12 MiB/job, 20 items and 16 MiB output. The record cap is a rolling admission limit, not lifetime exhaustion: tests exceed 128 admissions across expiry epochs and reject old IDs. Request-body deadline is five seconds. All result chunks/completion metadata commit atomically; rollback exposes no partial output. Storage outages can delay terminal recovery, never produce false success.

Ordinary modern object-stream PDFs use isolated parsing plus WU-152 post-load checks. Results distinguish per-item `embedded`/`linked-only` and original digests. Validation generates a private preview packet; it neither replaces the original nor establishes antivirus/rendering safety. Unsupported files are explicit linked evidence; selected invalid attachments fail without silent omission. Pixel, normalization/allocation and renderer limitations remain in [DOCUMENT-INPUT-VALIDATION.md](DOCUMENT-INPUT-VALIDATION.md).

### Original-byte preservation (WU-161)

Original metadata and chunk reads require exact `x-document-manifest-sha256` and `x-document-snapshot-sha256` request headers. Chunk reads additionally require `x-document-item-sha256` matching that ordered manifest item. Missing/wrong identities fail with 409; the service never selects another job, revision or snapshot. Indices use canonical unsigned decimal notation (zero or a nonzero digit followed by digits), must be safe integers and remain within the admitted item/chunk counts. Query parameters are rejected. These routes are service-only; consumers must attach current application/provider authority externally.

Metadata contains `jobId`, `itemIndex`, original `id`, `revision`, `type`, `byteLength`, `sha256`, `chunkSize`, `chunkCount`, `chunkSha256`, `manifestDigest`, `snapshotDigest`, `policyVersion`, `outcome` and `expiresAt`. It is available only after the complete job has exactly one matching successful `embedded` or `linked-only` outcome for that item and its admitted SHA-256. Linked-only remains unsupported for embedding, not a safety certification. Rejected, missing, unfinished, expired or legacy jobs without sealed chunk commitments cannot expose originals. Ordinary expired metadata may return 404 after cleanup, rather than 409 before cleanup.

At sealing, the existing whole-input SHA-256 verification produces per-chunk commitments from those same verified bytes; all commitments and queued state persist atomically. Before each original response, one stored chunk is read, its exact expected length and SHA-256 checked, and expiry rechecked. Missing/corrupt/replaced chunks fail with 409 without emitting original bytes. Metadata describes immutable commitments; it does **not** promise every chunk remains present. A trusted consumer must retrieve each chunk, check returned identities/offsets/lengths/digests and finally verify the concatenated whole-original digest before provider preservation. No whole-original response or automatic retry is added.

Binary headers are `content-type: application/octet-stream`, exact `content-length`, `cache-control: no-store`, `x-content-type-options: nosniff`, `x-document-item-index`, `x-document-chunk-index`, `x-document-byte-offset`, `x-document-sha256` (whole original), `x-document-chunk-sha256`, `x-document-manifest-sha256` and `x-document-snapshot-sha256`. Input commitments remain internal to ordinary status reads. Existing proof and generated-result routes are unchanged. Real local workerd tests cover original PNG/JPEG/modern object-stream PDF bytes, multiple chunks, restart, identity mismatches, corrupt/missing/cross-item storage, rejected input, old metadata and expiry. This is a transfer prerequisite; no Drive preservation or hosted acceptance is established here.

## Fixed development proofs

The API exposes `POST/GET /admin/document-compute/proofs/:fixedCase` and `GET .../:fixedCase/result` only for the exact development dashboard origin, optional binding and explicit synthetic mode. Existing session/current-role checks require Admin; the adapter reloads active Admin before forwarding and before returning data. A cross-service submission cannot be atomic with later account changes: accepted synthetic work may finish after revocation, but the revoked caller receives no result. Responses are bounded/digest-verified; arbitrary downstream fields/errors are omitted.

POST accepts exactly `{"confirmation":"RUN FIXED SYNTHETIC DOCUMENT COMPUTE"}`. Cases: `png-v1`, `jpeg-v1`, `modern-pdf-v1`, `mixed-v1`, `recovery-v1`, `cpu-fault-v1`, `memory-fault-v1`. No caller bytes, URL, loop count, allocation size or alternate identity is accepted. Fixed proof tombstones survive byte expiry forever; no reset/delete/retry route exists.

CPU fault is a fixed busy loop intended for platform termination. Memory fault retains/touches 4 MiB chunks up to a fixed 192 MiB attempted allocation; surviving the ceiling reports `FAULT_BOUNDARY_INCONCLUSIVE`. Local tests replace both faults with a subclass seam—no actual exhaustion was invoked. Hosted acceptance requires one authorized invocation each, authoritative exceeded-CPU/memory evidence (1102 alone is ambiguous), terminal state, normal next-job recovery and unaffected core health. Never automatically retry an uncertain/inconclusive fault. After the CPU-fault submission is accepted, send no requests to the compute service for at least 60 seconds before reading its status. Incoming Durable Object HTTP requests can reset the remaining CPU allowance; polling during that interval would weaken the termination evidence. Core-app health reads are independent and may continue.

## Local preparation and deployment preservation

`prepareDocumentCompute` in `scripts/document-compute-config.mjs` writes a new ignored `.provision` directory containing a prebuilt service, exact config and hashed manifest with `approval:false`. `verifyDocumentComputeBundle` rejects changed files/config, extra artifacts or mismatched reviewed digest/account/mode. Neither has a provider/deployment client. Use existing installed dependencies:

```powershell
& './node_modules/.bin/esbuild.cmd' ./experiments/pdf-spike/compute-worker.mjs --bundle --platform=browser --format=esm --outfile=experiments/pdf-spike/dist/compute-worker.mjs
node --test experiments/pdf-spike/compute.test.mjs experiments/pdf-spike/original-readback.test.mjs
node --test tests/document-compute.test.mjs
npm run verify:api
npm run verify:provisioning
```

Runtime tests need the separately pinned `experiments/pdf-spike` dependency installation; ordinary API tests do not import it. No root dependency/lockfile changes are required.

Only after approved creation and independent namespace capture may core's private identity add:

```json
"documentCompute": {
  "worker": "lancerlogin-v2-example-document-compute",
  "binding": "DOCUMENT_COMPUTE",
  "className": "DocumentComputeQueue",
  "migrationTag": "document-compute-v1",
  "namespaceId": "<independently verified provider ID>",
  "proofMode": "synthetic"
}
```

`proofMode:disabled` preserves binding without proof routes. Normal API bundles pin this approval and preserve it on redeployment. Old identities cannot silently remove a deployed binding. Preflight checks namespace/class, binding/mode, migration, absent unexpected secrets/bindings, exact provider-reported 30,000 ms CPU and disabled workers.dev/previews. Missing CPU metadata fails closed. Service namespace lifecycle is separate from API scheduler/password namespaces; no creation/capture dispatch is added.

Before **each hosted proof dispatch**, `prepareHostedComputeProof` requires a fresh complete account custom-domain and account-zone Worker-route inventory through an authorized read-only adapter. Mappings to this Worker, incomplete pagination, malformed results or missing access fail closed. It returns only a request description with `approval:false`, never sends the POST. Coordinator also completes service settings/namespace preflight and obtains exact-resource/reviewed-bundle authorization. Missing zone access requires equivalent verified coordinator evidence, not presumed privacy; keep the controlled acceptance free of concurrent external route/config edits.

D1 backup/restore does not restore transient compute bytes or remove DO tombstones. Product consumers must persist completed artifacts/packets before expiry. Namespace deletion/replacement erases fault replay protection and requires a new explicit operational decision, never automatic repair. No public file permissions are created.
