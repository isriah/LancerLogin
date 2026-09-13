# Document input validation experiment (WU-152)

Dependencies: WU-084/WU-119 PDF assembly and pinned `pdf-lib@1.17.1`; existing local Miniflare/workerd. Independent of WU-151 storage/authorization. No application route, provider call, resource identity, migration, dashboard or deployment is added.

**Production input/embedding approval remains unresolved.** Every experimental worker result contains `productionEligible:false`, including successful embeddings. This is neither antivirus nor a complete sanitizer, renderer-safety guarantee or enforced hosted memory boundary. Plan requirements for selected PDF-page/image embedding remain required; the restrictive profile does not replace them.

## Contract

Transport admission and embedding are separate. The experiment accepts bytes, exact declared MIME and an opaque selection; it never fetches a URL. It bounds consumed bytes, checks candidate signatures, hashes original bytes and attempts inspected embedding/serialization. `validateInput` returns only a **candidate**; `validateAndAssemble` reports `embedded` only after assembly succeeds. Unsupported MIME returns `linked-only` with an explicit index link. Neither outcome proves a file is safe to open.

The caller must preserve private originals when embedding is unsupported/rejected, then offer explicit linked selection or re-export. A failed requested PDF attachment must not silently become a successful link-only packet. This experiment never stores/deletes originals. Future adapters still own current installation/module/grant authorization, immutable file revision/digest binding, provider allowlists/fixed endpoints, signed-link expiry, transport deadlines, private copies and explicit selections. Provider MIME/size headers or successful copies are not content validation. No result authorizes publication or proves a source revision stayed current.

The local wrapper accepts `POST /strict` or `/isolated-comparison`, one binary body and optional `x-pages` comma-separated page selection. All other metadata is fixed synthetic data. It is not an authenticated public API. Its disposable runtime has no app bindings/secrets and denies outbound fetch.

## Compared PDF paths

Strict mode screens bytes before `PDFDocument.load`: bounded tokens/nesting/object declarations, escaped names, direct-length stream skipping, and rejection of encryption/active-feature names, object/xref streams and ambiguous/indirect lengths. Post-load checks reject cycles, active features/nonempty annotations, unsupported filters, excessive objects/depth/pages/geometry and oversized images. Empty annotation arrays from ordinary generated PDFs are accepted. Flate streams use bounded `DecompressionStream` consumption and inspected expanded contents replace compressed contents before assembly. Unsupported filters/decode parameters fail explicitly.

This custom screen is **not proven against all PDF syntax variants** and is not the primary security boundary. The pinned library's `PDFParser.parseIndirectObject` expands object/xref streams during load, before post-load inspection; it also tolerates/reconstructs some malformed structures. A successful load is not a conformance verdict.

Isolated comparison bypasses the lexical screen but retains post-load inspection/assembly. A normal modern compressed-object image PDF embeds here while strict mode rejects it. This shows compatibility potential, not a bound on earlier allocations. Parser/object-stream expansion, library recursion, native decoder chunks, serialization and garbage collection remain outside the counters. A future production path needs a proven enforced memory/CPU boundary and further normalization/rendering compatibility work. Permanently excluding ordinary modern PDFs is not an accepted product change.

PNG screening checks signature, chunk bounds/CRCs, dimensions, noninterlaced 8-bit grayscale/RGB/alpha, allowed chunks, decompressed row length and filter-byte range. JPEG screening checks marker/segment/scan structure, baseline/progressive 8-bit grayscale/RGB dimensions and final EOI without trailing data. JPEG entropy is not fully decoded by pdf-lib. PDF operators/fonts/image semantics are not independently rendered. Successful serialization does not establish renderer safety or visual fidelity. Indexed/interlaced PNGs, unusual JPEG encodings, annotations/forms, unsupported PDF filters/predictors, multilingual text and rotation need further compatibility work.

## Proposed defaults and enforceability

| Budget | Default | Limitation |
| --- | --- | --- |
| Input | 4 MiB/file, 12 MiB/packet, 20 items | Stream consumption bounded; original/normalized retained totals checked. |
| Pages | 40 source/file, 40 selected evidence pages | Source checks occur after parser load. |
| Images | 4 million pixels/image, 10,000 px/side; 4 million total PNG pixels | PNG dimensions before inflation; PDF image dimensions after parser load. |
| PDF graph | 2,000 objects, 100,000 lexical tokens, depth 32 | Comparison-mode parser allocations precede checks. |
| Expansion | 8 MiB/stream, 16 MiB cumulative PDF expanded content | Bounded consumption, not native allocation or process RSS. |
| Output | Existing 16 MiB serialized packet | Post-allocation check; normalized input can hit existing 4 MiB/file assembly limit. |
| Runtime | One disposable workerd per input, sequential fixtures; 20 s startup plus 10 s after ready | External process-tree termination, not JS timer preemption. |

A 4032×3024 phone-photo dimension fixture fails the 4-million-pixel default. This exposes a resize/re-export dependency. Defaults need representative adopter files and measured compute before production; no unlimited files/packets are promised.

Windows supervision uses `taskkill /PID <own-child> /T /F` and waits for successful tree termination. A deliberately infinite-loop workerd is killed at a 500 ms test deadline; the next independent runtime embeds a JPEG. POSIX process-group termination is implemented but unverified here. **No hard per-job memory limit, peak memory, CPU-time telemetry or hosted concurrency admission is demonstrated.** Elapsed milliseconds are wall-clock observations only. The test does not perform an unbounded allocation attack against the host to manufacture a memory claim. This remains a material production gate.

## Reproduction and evidence

Use existing pinned experiment dependencies and installed esbuild/Miniflare; no root dependency/download is needed. Generate original synthetic fixtures with `python fixtures.py` (Pillow/reportlab/pypdf), or reuse only those known generated fixture files in ignored output.

```powershell
# From experiments/pdf-spike; point to existing local installations.
& '<installed-esbuild.cmd>' ./input-worker.mjs --bundle --platform=browser --format=esm --outfile=dist/input-worker.mjs
$env:LOCAL_MINIFLARE='<absolute-installed-miniflare-package-directory>'
npm run test:input
npm test
```

The suite uses actual workerd through Miniflare 5.20260828.0-alpha, not Node Request/Response substitutes. Generated fixtures/results remain ignored under `output/input-validation/`; raw parser errors/input contents are not logged. Seven groups cover ordinary PNG/JPEG/vector/image PDFs, raw content streams, modern object-stream comparison, unsupported links, MIME/empty/byte limits, truncation, actual password-encrypted inputs, active/escaped names, indirect lengths, unsupported filters, depth/cycles/page/object limits, bounded compressed expansion, broken compression, CRC/trailing data, phone dimensions, forced termination and recovery. The existing 12 assembly/job groups also pass.

Initial successful local 2-page packets: PNG 17,234 bytes (~120 ms), JPEG 35,011 (~23 ms), vector PDF 2,430 (~30 ms), image PDF 35,931 (~30 ms), modern image PDF 35,931 (~33 ms, comparison only). These are illustrative single observations, not service guarantees; reruns overwrite the machine-readable result file. Linked text creates a 1-page index explicitly marked `linked-only`.

No dedicated Worker/DO identity or deployment is configured. Selecting isolated hosted compute, memory/CPU enforcement and any associated cost/resources requires a future user-authorized decision. Neither experimental path should be wired into core authentication or treated as production validation approval.
