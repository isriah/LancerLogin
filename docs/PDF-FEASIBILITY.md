# P0 / WU-084: bounded PDF assembly feasibility

WU-152 adds a [local document-input validation comparison](DOCUMENT-INPUT-VALIDATION.md). It demonstrates actual disposable-workerd execution and deadline termination, while leaving production memory isolation and general PDF/rendering acceptance explicitly unresolved.

Status: local prototype plus hosted synthetic feasibility evidence. The approved development Worker completed four alarm workloads and preserved completed results across redeployment; sampled CPU and periodic isolate memory observations are recorded in the development progress log. These observations do not establish per-job peak limits, arbitrary-file safety or real Drive streaming. Production files, production resources and the live Pi were not used.

The settled product contract is an index, ordered numbered image/PDF attachments, explicit links for other selected types, immutable selection provenance, and actionable failure for unreadable evidence. Exact budgets and compute placement remain proposed technical defaults. This prototype is not the final Documentation Form template, upload API, job system, sanitizer, publication system, or full packet feature.

## Implementation and reproduction

All executable code is under `experiments/pdf-spike/`. `assemble.mjs` uses Web streams, typed arrays and the exact isolated `pdf-lib@1.17.1` dependency. The [library documentation](https://pdf-lib.js.org/) describes its pure JavaScript implementation; [PDF page embedding](https://pdf-lib.js.org/docs/api/classes/pdfdocument) supplies the required primitives. The isolated manifest/lockfile intentionally avoids changing application dependencies. No install lifecycle scripts run.

From the experiment directory:

```text
npm ci --ignore-scripts --no-audit
python fixtures.py
npm test
npm run measure
pdftoppm -scale-to 1000 -png output/representative.pdf output/representative
pdftoppm -f 4 -l 4 -scale-to 1000 -png output/index-boundary.pdf output/index-boundary
```

Python requires Pillow, reportlab and pypdf; the Codex bundled Python supplied these during verification. Fixtures use geometric art, seeded random pixels, fixed synthetic labels, a three-page PDF, and a password-encrypted version with an explicitly synthetic password. Generated artifacts stay in ignored `output/`; no binary evidence is committed.

`assemblePacket(items)` accepts ordered records with opaque ID, revision, caption, approved HTTPS source link, MIME type and `Uint8Array` bytes. PDF pages are an explicit ordered, unique, one-based list. Link-only entries must explicitly use `type: 'link'`; unsupported MIME types otherwise fail preflight. It returns PDF bytes, page count, input byte count, and an allowlisted selection manifest. Source revisions are labels supplied by the trusted caller, not verified against a provider by this module. The caller must snapshot metadata, content hashes, source revisions, hours/metrics and definition revision with the immutable version.

`readBoundedStream` consumes chunks and cancels overflow. This proves a local stream boundary, **not Drive streaming acceptance**. Assembly still buffers source files and output; it is not streaming PDF generation. The provider adapter must authorize installation/file/revision, check MIME and size, choose fixed provider endpoints, bound fetch duration and cumulative downloads, and pass streams. The module never fetches source links, so those links cannot trigger server requests. Link accessibility remains a separate publication check.

Six local test groups cover deterministic bytes/manifests, ordered PDF page selection, numbered attachment starts, link annotations, PNG/JPEG embedding, corrupted/encrypted PDF errors, invalid/missing selections, metadata and HTTPS constraints, item/byte/pixel/source-page budgets, bounded stream cancellation, and multi-page index pagination. Encryption metadata is inspected with `ignoreEncryption` solely to reject encrypted files before reading pages; no password bypass or decryption is attempted. Error responses use fixed codes and opaque IDs, never library messages or source bytes.

## Measurements and proposed budgets

Windows, Node v24.14.1, one sequential process, one sample per case. Source allocation occurs before timing. RSS includes the Node runtime and allocator; after-RSS is not peak memory, and process-lifetime maximum RSS carries forward between cases. Measurements are local CPU/wall observations, not isolate usage, SLA, or worst-case bounds.

| Synthetic case | Input bytes | Output bytes | Packet pages | Wall ms | Process CPU ms | After RSS bytes | Lifetime max RSS KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Four 1200x800 PNGs | 53,044 | 65,397 | 5 | 296 | 516 | 89,288,704 | 102,872 |
| Six 1600x1200 noisy JPEGs | 10,333,884 | 10,339,479 | 8 | 25 | 31 | 90,292,224 | 102,872 |
| Thirteen three-page vector PDFs | 30,966 | 46,477 | 42 | 77 | 94 | 94,388,224 | 113,668 |

An exploratory twenty-PNG case reached 150,687,744 after-RSS bytes / 154,772 lifetime max RSS KiB, despite only 265,220 input bytes. This caused the aggregate decoded-PNG budget to be tightened. Compressed byte counts alone are insufficient.

Proposed and enforced prototype ceilings: 20 selected items; 4 MiB/file; 12 MiB total input; 40 source pages per PDF; 40 selected embedded pages plus up to four index pages; four million pixels per image; four million total PNG pixels; 16 MiB serialized output. Oversized output is detected after serialization, so that ceiling alone cannot prevent allocation failures. Embedded PDF resource streams may expand beyond source bytes and page counts. These limits do not establish safety against hostile/decompression-bomb PDFs. No arbitrary user uploads should be enabled from this prototype alone.

Proposed job envelope for a development test: one assembly at a time, 10-second CPU ceiling where supported, 60-second whole-job deadline including provider I/O, bounded retries only for provider transport failures, immutable input snapshot, and durable terminal failure. CPU-heavy parsing cannot be reliably interrupted with a JavaScript timer, so enforce runtime CPU limits. Admission control and per-isolate memory contention require design beyond a simple per-installation lock. None of these job controls is implemented here.

[Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) checked September 9, 2026 show 128 MB per isolate and 10 ms Free-plan CPU. Local results are not directly comparable, but give no basis to claim this fits Free-plan CPU. Confirm the authorized account plan before deployment. Paid plan selection or another compute resource/cost needs a material decision; this spike authorizes neither.

## Visual QA and remaining acceptance

Poppler rendered the mixed five-page representative PDF. The index, PNG, selected source PDF page 3, and JPEG pages were visually inspected: readable captions, correct source ordering, proportional scaling, page numbers and no clipping/overlap. The final page of the twenty-item/four-page index was also inspected. Poppler emitted environment display-font substitution warnings; rendered Helvetica text remained legible. This covers representative synthetic layouts only. Prototype metadata intentionally rejects non-ASCII text and caps captions at 180 characters; multilingual fonts, text wrapping by font metrics, long IDs, arbitrary page rotations, PDF annotations/forms, unusual JPEG encodings, and malformed resource streams require further implementation/QA. Embedded PDF page contents do not promise source form interactivity, signature validity, or annotations.

`worker.mjs` provides a fixed synthetic-only GET `/synthetic-packet` endpoint with no credentials, provider reads or user-file input. The repository-pinned esbuild successfully produced an 810.6 KiB browser/ESM bundle without Node compatibility; a Node import/Request/Response smoke test reopened its two-page PDF and checked its 404 route. This is only a JavaScript compatibility check, not workerd or deployment evidence.

For the maintainer's authorized development deployment: select the exact development-only Worker/account; use the established pinned Wrangler and a generated ignored config naming only that destination; bundle this endpoint and record bundle hash/size; dry-run first; deploy through the authorized coordinator; fetch `/synthetic-packet`, save privately, reopen and render the returned two-page PDF; record invocation CPU/memory/startup metrics and errors. Next replace fixed synthetic input through a trusted development-only fixture binding to exercise PNG/JPEG and boundary cases, then integrate authenticated Drive revision reads and bounded streams against the approved private test folder. Record upload/read-back hash and link accessibility independently. Run concurrent/cold-start repeats and hostile-file rejection cases before adopting budgets. Remove the smoke endpoint after acceptance. No deployment or provider result is claimed by this document.

## WU-084 followup: SQLite Durable Object alarm candidate

This followup supersedes the direct HTTP smoke endpoint as the proposed development compute test. `worker.mjs` is retained as the original Node contract proof but is **not** the template's deployed entrypoint. The new `job-worker.mjs` authenticates a lightweight request and forwards it to the single fixed `PdfSpikeJob` object. The object persists a job and an alarm before replying; only the alarm generates fixtures and assembles PDFs. The client can close after receiving 202. This is synthetic prototype work only; production packet jobs, provider connections and general upload processing remain unimplemented here.

Official [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) confirms SQLite Durable Objects are available on Workers Free; exhausting a Free allowance fails subsequent operations until reset rather than authorizing a paid plan. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) specifies a default 30-second CPU allowance per invocation, including alarms. This is a distinct candidate from the ordinary Free Worker request CPU envelope described above. It does not establish that any particular assembly fits deployed limits. No paid subscription or CPU override is selected in this spike. [Alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/) provide at-least-once delivery, independent of an open browser; duplicate deliveries and interrupted attempts require persisted idempotency.

The proposed `wrangler.pdf-job.template.jsonc` names exactly `lancerlogin-v2-example-pdf-spike`, class `PdfSpikeJob`, binding `PDF_SPIKE_JOBS`, and migration `v1` with `new_sqlite_classes`. It contains no account identifier or secret. Compatibility date is `2026-09-04`, supported by the installed workerd binary; a newer date initially failed local startup and was corrected before acceptance. The actual account and external resource creation remain coordinator authorization gates. Wrangler 4.127.1 local `deploy --dry-run` succeeded: 909.84 KiB upload / 248.31 KiB gzip, one DO binding, no external resources created. Independent browser/ESM esbuild output was 877.9 KiB.

### Bounded endpoint contract

- Every request needs a secure `SPIKE_TOKEN` bearer credential (at least 32 characters). No configured secret fails closed. Both outer Worker and DO authenticate; digests are compared without early per-byte exit. Logs/status never include token values or arbitrary exception messages. Test code uses a plainly synthetic constant that must never be deployed as a real credential.
- Exactly twelve IDs exist: `vector-1..3`, `png-1..3`, `jpeg-1..3`, `mixed-1..3`. Arbitrary IDs, query strings, uploads and request bodies are rejected. Nothing fetches a user-supplied URL. A single named object bounds namespace growth; it admits one active assembly at a time, returning 409 for a different new job while busy.
- `POST /jobs/{id}` with an empty body atomically persists `queued` and an alarm, then returns 202. A repeated ID returns the same durable job (200 when terminal, otherwise 202) and cannot regenerate or replace its result. `GET /jobs/{id}` returns allowlisted state. `GET /jobs/{id}/result` returns the completed PDF with SHA-256 and page-count headers, or 409 before completion.
- The alarm persists `running`, increments a maximum of three attempts, and schedules a 60-second watchdog before computation. It stores result bytes, digest and `complete` together transactionally. Exceptions reschedule a bounded retry; exhausted attempts become durable `failed`. A restarted running attempt can repeat deterministic work but cannot publish a partial result. The watchdog is a recovery schedule, **not a hard runtime or CPU deadline**. Platform CPU/memory termination must still be measured. Storage outage or quota exhaustion can prevent progress despite these controls.
- Result storage is capped at 1 MiB per job, below the SQLite KV value limit; at most twelve terminal jobs remain. No deletion/reset endpoint permits bypassing this bound. Result/status retention is therefore bounded but intentionally indefinite for the spike. It does not implement production retention, cancellation, full job admission quotas, provider retries, multi-tenant authorization, or global memory guarantees.
- Fixed image constants in `synthetic-images.json` come solely from `fixtures.py` geometric PNG/JPEG outputs; regenerate with `node export-job-images.mjs`. They contain no provider material. Vector PDFs are generated inside alarms. The fixtures cover four PNGs, six geometric JPEGs, 39 selected vector pages, and one mixed packet with an explicit unsupported-material link. The earlier noisy JPEG benchmark is not the deployed fixed JPEG case.

### Local execution evidence

`npm test` now passes twelve groups: the original six plus authorization/ID/body checks, queued-state and immutable result/digest checks, bounded failure across object recreation, interrupted-running watchdog recovery, fixed-workload caps, and atomic-completion rollback with successful retry. The storage test double checks logical contracts, not Cloudflare scheduling guarantees.

`local-job-smoke.mjs` uses installed Miniflare 5.20260828.0-alpha through its v4-options converter, SQLite storage and real **local workerd**. It bundles no Node runtime dependencies into the Worker. No providers or remote bindings are configured; telemetry is disabled. Each submitted HTTP request returns before the alarm runs, with a two-second interval without client requests. All four cases completed once, their returned PDFs reopened, and their SHA-256 digests matched status. A full local runtime shutdown/restart preserved a completed job/result; a separately queued job also completed after restart with the same digest. The test's `output/workerd-results.json` records local observations only.

| Fixed case | Pages | Result bytes | JS elapsed ms, one local run | Attempts |
| --- | ---: | ---: | ---: | ---: |
| Mixed | 5 | 53,416 | 108 | 1 |
| Four PNGs | 5 | 65,627 | 223 | 1 |
| Six geometric JPEGs | 8 | 204,994 | 21 | 1 |
| 39 selected vector pages | 42 | 39,274 | 39 | 1 |

These `Date.now()` differences are coarse JavaScript elapsed values around assembly/hash, with some async work, and **are not CPU telemetry or peak-memory measurements**. Local workerd success does not establish deployed Free-plan acceptance. The mixed packet's rendered index and PNG page were visually inspected again: readable numbering/captions, no overlap, and correctly scaled evidence. Existing image/PDF safety and multilingual limitations remain.

Reproduce after `npm ci --ignore-scripts --no-audit` and fixture generation:

```text
esbuild ./job-worker.mjs --bundle --platform=browser --format=esm --outfile=dist/job-worker.mjs
node local-job-smoke.mjs <absolute-installed-miniflare-package-directory>
wrangler deploy --dry-run --config wrangler.pdf-job.template.jsonc --outdir output/job-dry-run
```

Use the repository's existing pinned tool executables; do not install or change root dependencies. Run the smoke harness from the experiment directory. Its SQLite directories, generated PDFs, logs and bundle stay under ignored `output/` or `dist/`.

### Authorized live telemetry procedure, still pending

1. The maintainer must resolve the exact account and approve creation of this development-only Worker/SQLite namespace before deploying. Keep the existing Free plan; do not change billing. Create a distinct random secret through secure local tooling and bind `SPIKE_TOKEN` without printing or committing it. Run dry-run again on the integrated commit, then deploy only the authorized exact target with no production bindings.
2. Verify unauthenticated POST/status/result return 401 and invalid IDs/bodies do not create jobs. Submit `mixed-1` with the secure header, close the initiating client after 202, and later read status/result from a fresh client. Independently hash, reopen and render the returned PDF. Repeat the other fixed `-1` workloads serially. Use `-2`/`-3` only for planned cold/warm or overlap observations; the ID budget deliberately prevents unbounded repetition.
3. Record deployment version, invocation type (outer fetch versus DO fetch versus **alarm**), successful/failed outcomes, retry count, provider-reported alarm CPU, duration and available memory statistics from Cloudflare Workers/DO observability. JS `elapsedMs` is supporting metadata only. Do not label ordinary fetch CPU as assembly CPU. If account telemetry cannot expose per-alarm CPU or memory, record that limitation and leave that acceptance claim open; no estimates from wall time or Node RSS can substitute.
4. Verify durable idempotency after duplicate POST, stable digest after reconnect, and startup/bundle limits. A controlled restart/version-redeploy drill needs coordinator authorization and must preserve the same SQLite namespace/migration; never delete it to simulate recovery. Mocked retry tests do not prove cloud eviction recovery. Inspect runtime exceeded-CPU/memory, alarm retry and quota errors before accepting any budget. Remove or disable the spike endpoint/secret under the maintainer's authorized cleanup when its evidence is complete.

No cloud deployment, paid-plan change, live alarm telemetry, provider read/write, or public packet publication was performed for this followup.
