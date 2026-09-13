# Internal same-epoch application restore (WU196)

`createApplicationRestore` is an internal transport, **not wired into runtime, engine adapters or public recovery**. It restores only an original independently replay-validated schema46/49 backup during the same continuously closed maintenance epoch. Dependencies: compiled46–49 catalogs (WU195), actual verified backup/capture, and later positive deployed-writer attestation plus durable recovery handoff. There is no boolean quiescence option, portable import policy change, resource creation, hosted operation or general disaster-recovery claim.

## Authority and later handoff contract

Constructor inputs are private capability, separately pinned application/updater D1 bindings, encrypted artifact store/checkpoint cipher, pinned application verifier, and a trusted `withWriterFence` function. The module checks binding objects and IDs are distinct. Every invocation independently reads primary engine, owner and maintenance state; the original checkpoint and retained backup receipt; exact migration-operation identities; completed deployment receipts; all active application permits/pending execution ambiguities; and the sole current updater hold. The current restore operation/job must match the closed epoch and original checkpoint. Unknown migrations cannot become terminal failed history merely to authorize restoration.

Trusted future orchestration must retain the failed job and installed state **before** engine recovery replaces them. After exact recovery admission readback it binds the recovery job/request; once the engine has created the restore operation it binds that operation and current live hold. The transport requires the resulting encrypted `restore-handoff:<recoveryJobId>` record:

```
{ installationId, failedJob, failedInstalled, checkpointJobId,
  backupId, backupSha256, epoch, recoveryJobId, requestId,
  operationId, holdId,
  fence: { accountId, worker, manifestSha256, configurationSha256 } }
```

This is protected updater-store history, never request JSON. The future orchestration writer must use primary CAS and prove each binding from the actual engine/core state. Hold IDs change on each invocation; only `holdId` may be refreshed under the same immutable operation/epoch/job tuple. Restore commitments exclude the hold ID. Missing/inconsistent history blocks before target mutation.

Applied migration/deployment entries exclude `failed:true`. The authoritative archived engine entry is definitive rejection evidence: engine records it only for a trusted `failed` plus `terminal:true` adapter result and leaves installed schema unchanged. There is no invented terminal-failure store or proof producer. A SQL exception remains an unknown active operation and cannot be archived as terminal merely to permit restoration. The fixture includes successful47 followed by a failed48 entry, as well as a failed deployment in the49 case.

The attestor request has exactly `{installationId,applicationDatabaseId,epoch,jobId,operationId,holdId}`. It must positively prove deployed code/settings include complete writer fencing, reject other provider/migration ambiguity and preserve exclusion throughout the callback, including unknown target outcomes. Its trusted callback evidence contains those six fields plus account, Worker, manifest and configuration digests matching the archived fence. Richer attestor fields are permitted. A later attestor may require bounded `prepare` calls before invoking this transport. No caller-provided flags or zero-permit observation can substitute for that evidence. WU196 tests deliberately inject a synthetic positive attestor; they do not establish deployed coverage.

Continuous closure prevents admitted application work from consuming or changing captured OAuth/Picker/provider-operation rows after backup. Exact raw restoration therefore does not rewind such consumption within this narrow window. It does not freeze external administrators, revoke/restore provider credentials, undo accepted email delivery or suspend independent provider processing. Existing timestamps and provider reconciliation remain necessary. Any reopened epoch, unprotected writer, unresolved operation or foreign hold blocks this path.

## Durable mutation and finalization

Before the first application mutation, the encrypted updater operation records immutable identity, backup/catalog commitments and a pending bootstrap step. One target transaction creates `_ll_restore_owner` and `_ll_restore_steps` and checks exact compiled schema plus native migration names inside its NOT NULL ownership guard. Schema is a bounded JSON parameter, not interpolated executable SQL or an unchecked preflight read. SQL is limited to100 KB, bound parameters to100 and the compiled schema parameter to1.5 MB. Target works are limited to eight per guarded batch; data rows retain existing typed-page and byte limits.

Cleanup drops triggers, deletes child-first in64-row portions and drops tables in reverse FK order. Rebuild creates compiled tables, early FK unique indexes, parent-first typed rows, exact sequence contents, then indexes/triggers. Values use typed CAST bindings, preserving integer text, rowids, REAL representations and text/blob bytes. The application target is identified as the application database; no validation-database pin is repurposed.

Every batch has an encrypted pending record before dispatch and an atomic target owner/step guard, receipt and cursor. Lost acknowledgment reads only the exact receipt and never dispatches again from absence or timeout. Schema drift during ownership admission rolls back the entire ownership batch. Confirmed restoration compares every typed page, empty tables/trailing rows, native ledger, sequence, complete catalog, foreign keys and supported `quick_check(1)`.

Final metadata removal cannot leave receipts inside the exact application schema. Before the guarded removal batch, the updater retains its pending identity/cursor and prior completed comparison. If acknowledgment is lost, primary absence of **both** metadata tables allows only a new bounded full comparison—not completion or redispatch. The final receipt is written only after this fresh data/schema/ledger/FK/quick-check pass. Metadata still present or an inconsistent target remains blocked. An unprovable bootstrap/finalization outcome has no force-clear or timed retry.

Completion returns `{outcome:'applied', receipt:{backupId,sha256,schema,identity}}`. Pending steps return `pending`; failures return `unknown` with a fixed bounded reason allowlist. SQL/provider exception strings are not returned. Application restoration does not change engine installed state, high-water sequence, maintenance state or retained backup records; future engine composition applies the validated receipt and must keep maintenance closed through prior-code deployment and fresh health.

`reconcile(capability,{jobId,operationId})` is strictly read-only, including the missing-record path: it cannot claim, persist errors/cursors or dispatch. Exact pending target evidence can return `pending` for a later separately authorized advance; absent or mismatched evidence stays unknown. Completed encrypted receipts can be returned as applied. This separation prevents an unknown initial engine dispatch from accidentally authorizing first mutation during readback.

## Local evidence and limits

`node --test tests/updater-application-restore.test.mjs` covers populated47→46 and49→49 destructive restoration using real SQLite, actual signed releases, actual backup capture/replay and the real47 migration transport. It checks typed data/documentation revisions/sequence, rotating holds, denied attestation, epoch mismatch, missing retained backup receipt, foreign owner, extra final rows, schema drift after admission, and lost bootstrap/data/final-cleanup acknowledgments. Backup and engine-state records remain intact.

One additional47→46 case uses actual local Miniflare D1 for the destructive target, including guarded schema DDL, CAST parameters, final cleanup acknowledgment loss and final comparison. It does not use hosted D1. Node fixture peaks are23/20 binding calls per advance; future attestation and orchestration costs are excluded. Supported larger data/CPU/rows and combined hosted limits require later acceptance. No broad production test suite or runtime enablement is implied.

The first four-case pass completed in106.679 seconds, including the actual Miniflare destructive case in95.303 seconds. After the scoped terminal-entry/read-only reconciliation correction, only the three affected Node cases were rerun; integrated acceptance is recorded by the maintainer. Reconciliation tests compare encrypted store rows before/after and assert zero target batches.
