# Consecutive runtime updates and continuation cost (WU191)

The focused runtime fixture completes two updates using the same pinned application, updater-state and validation databases: schema 46/version 1 to schema 49/version 2, then schema 49/version 2 to schema 49/version 3. It seeds 1,000 synthetic audit rows plus the existing members and documentation-history fixture. All release bytes are signed with an ephemeral synthetic key. Real runtime, engine, backup capture/replay, generation cleanup, migration and deployment adapters run against local SQLite bindings and synthetic Fetch responses; no hosted resources are contacted.

The first upgrade retains its verified schema 46 backup through migrations 47-49, including the existing lost47 acknowledgment. The next update owns a distinct job and later closed epoch, reuses the completed validation target and retains a verified schema 49 backup. Every seeded audit row, including rowid and every column, is compared exactly in both application and validation databases after each update. Both encrypted backup receipts, the first full snapshot/replay records and a sealed historical page remain intact. The runtime is reconstructed during each operation. The second update applies no migrations. This tests full backup/runtime composition rather than replay alone.

## Measured fixture results

Command: `node --test --test-name-pattern="profiles two consecutive" tests/updater-runtime.test.mjs`

One focused case passed in 38.789 seconds. Defaults of the two existing scenarios remain unchanged; this command runs only the new representative case.

| Measurement | First update 46 to 49 | Second update 49 to 49 |
| --- | ---: | ---: |
| Advance requests | 649 | 841 |
| Advances reporting backup step | 524 | 720 |
| Advances reporting stageArtifact | 103 | 103 |
| Application SQL executions | 213 | 135 |
| Updater-state SQL executions | 23,872 | 31,494 |
| Validation SQL executions | 2,198 | 2,991 |
| Total SQL executions | 26,283 | 34,620 |
| D1 binding method calls | 24,836 | 33,048 |
| Read-only synthetic Fetch requests | 873 | 873 |
| Mutating synthetic Fetch requests | 3 | 3 |
| Start/admission SQL executions | 40 | 40 |
| Start/admission binding calls | 40 | 40 |
| Start/admission Fetch requests | 12 | 12 |
| Maximum SQL executions in one advance | 87 (applyMigration) | 52 (backup) |
| Maximum binding calls in one advance | 51 | 48 |
| Maximum Fetch requests in one advance | 8 | 8 |
| Local measured update elapsed | 12.322s | 24.948s |

SQL counters increment on actual first/all/run execution and each executed batch statement, not prepare. SQLite BEGIN/COMMIT plumbing is excluded. Binding calls count one batch invocation independently of its statement count. Read-only provider D1 ledger-query SQL is included in application SQL, while its transport remains a Fetch call rather than a binding call. Fetch classification treats GET, ledger-query POST and check-missing POST as reads. Admission is measured separately as action=start, step=admission; its 40 binding calls and 12 Fetch requests occur in the same admission request. Separate advance maximum columns need not occur in the same advance and must not be summed as an observed peak.

Counters cover admission and continuation through reopening; bootstrap and availability discovery are excluded. Test-only assertion queries are excluded. The first case includes the one lost migration acknowledgment and its reconciliation. Local wall time includes synthetic transport and Node cryptography, not network latency or Worker CPU limits. These numbers are neither D1 rows read/written nor a hosted quota acceptance result. Full-facade binding counts warrant separate request-budget review; a small standalone adapter fixture does not establish the composed runtime budget.

## Driver/session implication

At one second between advances, pacing alone adds at least 648 seconds (10m48s) for the first update and 840 seconds (14m) for the second. HTTP latency, execution time, admission, retries, visibility pauses and operator delays are additional. A 900-second absolute session would leave only about 60 seconds beyond the second update's pacing overhead. The fast local elapsed time is not evidence that hosted execution fits that margin.

This fixture therefore does not justify a fixed 900-second end-to-end lifetime. Session expiry/renewal and foreground driver pacing need an explicit decision using these counts, and broader row/page sizes can require more continuations. This unit makes no production optimization or authentication/UI change. It records an executable regression and measured basis for subsequent decisions.

## WU192 request-local read reductions

Application and recovery advance responses now enrich the completed orchestration status instead of discarding it and requesting another status. Both retain a fresh stored job/request-ID consistency check. Each independent `withClosedEpoch` boundary now reads engine, owner and maintenance state together on the primary; it still checks the private live hold and performs the conditional hold write. No authority is cached between boundaries and intermediate schema47/48 checkpoint-lineage checks remain unchanged.

Backup validation opens one callback-scoped, opaque completed-manifest reader. Capture owns the reader in a private WeakMap, binds it to the snapshot and revokes it in `finally`. Replay and page reads can reuse that verified manifest only during the callback. Returned manifests are copies. Forged, foreign, expired and wrong-snapshot readers fail. Every page read still fetches sealed metadata and encrypted chunks, authenticates/decrypts them, verifies the whole page digest and checks canonical typed contents. There is no cross-request cache and no caller-supplied trusted manifest.

Command: `node --test --test-name-pattern="profiles recovery facade" tests/updater-runtime.test.mjs`

One actual runtime case passed in 34.055 seconds using local SQLite and synthetic provider Fetch. Explicit recovery sign-in and initial CSRF acquisition precede measurement. Starts still use the authenticated application service; every measured advance uses the actual independent recovery service, including session lookup, CSRF/nonce enforcement and response status enrichment. Runtime reconstruction reuses the durable session. The original application-facade profile above is retained as historical evidence; these are different facade measurements, not an identical-route benchmark.

| Measurement | First update 46 to49 | Second update49 to49 |
| --- | ---: | ---: |
| Advances | 649 | 841 |
| Application SQL executions | 213 | 135 |
| Updater-state SQL executions | 17,397 | 22,526 |
| Validation SQL executions | 2,198 | 2,991 |
| Total SQL executions | 19,808 | 25,652 |
| Total D1 binding calls | 18,361 | 24,080 |
| Read-only / mutating Fetch calls | 873 / 3 | 873 / 3 |
| Local update elapsed | 11.206s | 21.451s |

Coincident per-advance measurements, rather than sums of unrelated peaks:

| Peak | First: SQL / binding / Fetch | Second: SQL / binding / Fetch |
| --- | --- | --- |
| SQL peak | migration: 78 /42 /0 | API deploy: 42 /42 /5 |
| Binding peak | API deploy: 43 /43 /5 | API deploy: 42 /42 /5 |
| Fetch peak | staging: 32 /32 /8 | staging: 32 /32 /8 |
| Largest binding-plus-Fetch observation | API deploy: 43 /43 /5 | API deploy: 42 /42 /5 |
| Application admission, separately measured | 40 /40 /12 | 40 /40 /12 |

The fixture asserts at most44 D1 binding calls per recovery advance as an engineering margin. SQL executions count individual batch statements; binding calls count one batch invocation. These are not D1 rows read/written. The coincident binding-plus-Fetch observation is diagnostic, not a claim about exact platform enforcement. Current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) document50 Free queries per invocation; [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) separately document50 general subrequests and1,000 internal-service subrequests on Free. CPU, actual row charges, hosted enforcement and maximum artifact-size composition remain separate acceptance gates.

Focused regressions cover independent authority/concurrency/orphan holds, service status reuse, reader ownership/revocation, mutation of returned descriptions and encrypted page tamper while a reader is live. No batch sizes, driver delay, session lifetime, authentication authority, engine dispatch semantics or maintenance assertions changed. Continuation counts and the900-second foreground-session concern remain unchanged.
