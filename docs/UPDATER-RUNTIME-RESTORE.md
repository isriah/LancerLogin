# Optional restore runtime composition (WU198)

Dependencies: WU196 guarded application restore, WU197 deployed writer-fence evidence, trusted deployment adoption and reviewed writer coverage. This unit composes existing transports; it does not provision resources or expose a raw engine/public initialization method.

`createUpdaterRuntime` accepts optional constructor-only `fencePolicy = {maintenanceService, secretBindings, adoption, coverage}`. Other resource pins, Worker settings and nonsecret bindings remain the existing exact runtime contract. WU197 validates the policy and resources at construction. Omission keeps restore unavailable; no HTTP request, release file or browser can enable it. Synthetic fixture coverage/adoption is explicitly test-only. Real adoption, exclusive writer/deployment ownership and hosted acceptance remain prerequisites.

## Recovery authority and interruption

The existing authenticated recovery action and explicit RESTORE APPLICATION DATABASE confirmation remain the control path. Delegated Admin control still cannot restore. Orchestration enables its private existing engine restore capability only when the optional runtime adapter exists; no engine API expansion is needed.

Before replacing a failed update job, runtime encrypts `restore-archive:<requestUUID>` containing its exact terminal job/completed entries, failed installed state, original checkpoint/verified backup and closed epoch. The owner's revision-guarded handoff transition binds that archive. A conflicting transition cannot replace its contents. Existing archived failed:true completion entries remain definitive rejection evidence; no fabricated terminal-proof records are introduced.

After idempotent recovery admission, `restore-handoff:<recoveryJobId>` binds the new job and original lineage. Core handoff retains the original epoch. The eventual restore operation and fence hashes are bound before application mutation. Each continuation refreshes only its current holdId through CAS; the epoch/job/operation/archive tuple cannot change. Intermediate47/48 orchestration checks recognize only this exact archived restore lineage, rather than pretending the replaced recovery job is the failed update.

An encrypted archive write whose acknowledgment is lost can leave the authenticated admission pending before owner transition. The recovery service now resumes only the same pending UUID/failed-job/mode through the existing idempotent orchestration method. Accepted/rejected requests never start another job; mode conflicts reject. GET status remains read-only. Concurrent pending retries converge on one recovery job.

## Execution and evidence

The internal runtime-restore adapter enters one fresh `withClosedEpoch` callback per invocation. Its in-memory authority scope exists only for that exclusive active hold and is deleted in finally. WU197 callbacks reuse that invocation's primary authority and engine-decrypted checkpoint, never a persisted/cross-invocation shortcut. WU196 still performs its independent primary ownership/checkpoint/permit/receipt checks. Current deployed release expectation derives from the archived successfully completed API deployment, or the prior release when no API deployment completed; WU197 independently proves actual deployed content and identity.

WU197 preparation completes in two bounded calls before WU196 dispatch. An additional bounded call binds selected completed fence evidence to the handoff. Unknown preparation never invokes restore. Later protected uses retain fresh provider deployment/settings readback. A readonly reconciliation does not prepare new fence evidence or bind a missing initial fence: it returns unknown. Rotating live-hold bookkeeping may update the handoff, but WU196 reconcile never writes application data or advances its restore cursor.

Continuation holds are inserted with an already-persisted operation ID when one exists. The fresh primary authority join verifies that active hold and exact operation; it skips a redundant UPDATE only when already bound. First dispatch still conditionally binds the newly created operation. Incorrect operation/hold authority fails closed.

WU196 verifies its restoration receipt before the engine installs the prior schema/ledger. The same closed epoch remains through prior Pages/API activation, fresh health and reopening. A restoration/provider ambiguity cannot expire ownership or permit a new operation. External Google/Drive/Discord effects are not rolled back. Restored publication/ownership records do not imply those external effects were undone.

## Focused acceptance

`node --test --test-name-pattern="runtime restores46" tests/updater-runtime.test.mjs` uses actual SQLite databases and real signed transports with synthetic Fetch. It upgrades populated46 through all real migrations to49, encounters definitive health failure, explicitly authenticates restoration, restores46, activates prior code, verifies health and reopens under the original epoch. It preserves audit and documentation revision rows, verified backup lineage and the monotonic release high-water mark. It injects lost archive acknowledgment before owner handoff and lost committed restore-target acknowledgment, reconstructs runtime during progress, and rejects restoration when policy is omitted. This is a49-to46 full runtime drill; WU196 separately covers actual47-to46 destructive transport.

`node --test tests/updater-orchestration.test.mjs tests/updater-recovery-service.test.mjs` covers intermediate47 admission using a narrow orchestration fixture, lost core handoff, exact-mode replay, concurrent pending recovery retries, readonly status and existing failed/closed/orphan behavior.

The final candidate drill passed in45.82 seconds:349 update advances and324 recovery/status/admission invocations, with recovery peak49 D1 bindings and3 coincident Fetch requests. Initial update peak44 D1 bindings and5 coincident Fetch, with separate Fetch peak8 (start admission42 D1/12 Fetch). The10 focused orchestration/recovery checks passed in2.70 seconds. The fixture counts SQL executions, D1 binding calls and provider Fetch separately for every recovery invocation, with a49-binding ceiling reserving one call for WU199's routing/bootstrap gate. Batch SQL statement counts are not D1 row-read counts. Actual hosted CPU, latency and platform quota acceptance remain outstanding; the900-second session does not promise all snapshot sizes can complete.
