# Maintenance admission foundation

WU-177 supplies independent durable admission and a reusable execution scope.
Dependencies: WU-169 updater isolation/authorization, the approved whole-execution
permit design, and later complete application execution/egress integration.
It does **not** gate the current API, change engine ordering, implement migrations
or restore, or justify `recoveryQuiescence: true`. All evidence here is local.

## Durable boundary

Apply `apps/updater/state/0005_updater_maintenance.sql` only to updater D1. Its
singleton installation pin, maintenance epoch, permit tombstones, and ambiguity
records must survive replacement of application D1. No application backup owns
these tables. The core accepts the pinned database at construction, never URLs,
resource overrides, SQL, credentials, or browser role assertions.

`createMaintenanceCore` requires separate exact object capabilities for execution
and maintenance control. These are server-side composition boundaries, not HTTP
authentication. Future transport must authenticate installation/audience/replay
and must not expose the core's unrestricted release method to an operator. Only
the live scoped execution that has revoked its capabilities may release itself.

`initialize` creates epoch zero/open once. `admit({permitId})` is a conditional
INSERT from the open singleton. `close({epoch,jobId})` atomically advances that
epoch to draining. Either admission wins and leaves an active permit, or closure
wins and admission fails. No separately read flag authorizes execution. Identities
are immutable and never reused, including after release. Duplicate admission
does not return an executable handle; a lost admission acknowledgment can leave
an orphan, but cannot authorize duplicate execution. Opaque handles belong to the
issuing core instance; diagnostic readback cannot reconstruct one after a crash.

`ready(epoch)` conditionally changes draining to closed only when no active permit
exists. Pending ambiguities prevent their permit's release. Partial indexes bound
both existence checks to current active/pending records rather than historical
logs. `status` reads the singleton and at most one active permit and one pending
operation; it does not count or enumerate the history. Its multi-query diagnostic
view is not the atomic authorization to restore; that is the closed epoch.

Every core statement requests `withSession('first-primary')` when supported.
The fallback adapter **must be primary-only**; a replica-capable adapter lacking
that method is not supported. Hosted composition must preserve this contract.
There are no replica-stale zero-count decisions or heartbeat writes.

`reopen(epoch)` requires closed state and a constructor-supplied
`readReopenEvidence({installationId,epoch,jobId})`. It must independently load
trusted terminal job and verified health records for that exact epoch/job, and
return matching identities plus `jobTerminal:true, healthVerified:true`. Those
flags are an adapter contract, not evidence supplied by an app/browser request.
The final SQL checks the exact closed epoch/job and zero active permits again.
Repeated successful close/reopen calls can reconcile lost acknowledgments.

## Execution scope contract

`admitExecutionScope({core,capability,permitId?})` returns null if not newly admitted.
Otherwise `scope.run(handler)` runs exactly once. It returns the handler result;
`scope.done` settles separately after all tracked work finishes. Future Worker
integration must register that drain promise with the actual runtime context.
The scope's `waitUntil` tracks dynamic/nested registrations. It does not use a
single early snapshot of promises. Handler rejection also drains tracked work,
including diagnostic/error-path work registered inside the execution.

`mutation(kind,dispatch,isDefinitive)` creates a revocable, tracked callback.
Dispatch receives `{operationId,permitId,epoch}` first, followed by call arguments.
A provider adapter can associate that identity with its operation-specific
evidence. The trusted classifier must establish remote terminal completion; its
default is false. Fetch fulfillment, abort, a caught exception, a timeout, or an
HTTP error alone do not establish completion. Track the original operation promise
even when application code races it against a deadline. An adapter returning a
Response must also account for any required body consumption or asynchronous
provider processing in its completion contract.

Normal operations are tracked in memory under the durable ACTIVE permit. Only
ambiguous outcomes add a pending operation row, recording bounded kind/identity
without payloads or credentials. The local scope retains ambiguity **before**
attempting that write. Failure of the ambiguity write cannot allow release; a
crash at any point leaves the original ACTIVE permit. Trusted
`resolveOperation` readback must return `outcome:'complete'` with the exact
operationId/permitId/epoch before the row is completed. It must use actual
operation-specific evidence, never absence, elapsed time, or a caller assertion.
The core supplies no fake generic provider resolver.

When handler plus tracked work settle, the scope synchronously revokes local
capabilities before attempting durable release. `done` reports released, blocked,
or release-unknown. `retryRelease()` is available only on that revoked live scope;
it checks at most one retained ambiguity per call, recreates a missing ambiguity
row if necessary, and releases only after all are definitively resolved. An
acknowledged release retry is idempotent. A replacement process cannot use this
method to release a former process's permit.

`wrapD1` guards prepared statements, bind, first/all/run/raw, batch and exec;
foreign statements cannot enter a scoped batch. A fulfilled D1 result without
`success:false` denotes completed execution; rejected SQL remains conservatively
ambiguous. `wrapService` requires a trusted completion classifier. `guard`/`track`
are only for work already known not to leave an ambiguous external mutation.
Neither promise tracking nor an environment wrapper can intercept unwrapped
global fetch, leaked raw bindings, or arbitrary untracked callbacks. There is no
process-wide fetch replacement. Session methods not exposed by `wrapD1` need
explicit scoped composition before use.

## Required next integration and limits

Wire all HTTP execution (including authentication and error telemetry), cron,
scheduler alarms, actual waitUntil work, D1 and provider/service dispatch through
the scope. Preserve scheduler accounting when composing its existing DB wrapper.
Explicitly pure health/preflight paths can remain outside admission. Current
provider helpers using global fetch need scoped transport propagation. This
foundation alone establishes none of that coverage.

Orphan permits never expire and cannot be force-cleared. Completing an operation's
readback does not prove a suspended execution cannot resume and dispatch again.
An orphan can therefore indefinitely block maintenance. Infrastructure fencing
for recovery from that condition is a separate required design, not an operator
delete button. Ordinary clean execution drains without a new Durable Object.

## Cost and local evidence

A normal admitted execution makes **two updater SQL writes**: insert its permit,
then update it to released. It retains one small tombstone row plus index entries.
Wrapping additional successful SQL/provider calls adds no updater queries or
writes. One ambiguity adds one operation row; positive reconciliation updates it.
Readiness uses a conditional update plus primary state read; diagnostics use two
or three bounded primary reads. There are no periodic lease/heartbeat writes.
D1 billed row/index write costs are not necessarily identical to statement counts.
Retained tombstones and ambiguity history grow with traffic; garbage collection
requires a later replay-safe design. No Free-plan capacity claim follows from
these statement bounds. Hosted quota/latency/CPU and complete integration remain
acceptance gates; this work makes no hosted D1 calls.

Run `node --test tests/updater-maintenance.test.mjs`. Real separate local SQLite
connections exercise admission/closure ordering, lost acknowledgments, opaque
ownership, partial-index selection, exact reopening evidence, nested background
work, deadline losers, ambiguity persistence failure, SQL writes and revocation,
and application database replacement. The shim rejects non-primary session use.
