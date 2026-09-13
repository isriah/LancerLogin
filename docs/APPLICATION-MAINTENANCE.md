# Application maintenance integration

WU-179 connects WU-177 permits to application execution. Dependencies: the
independent updater D1/core, private service authentication, pinned provider and
compute bindings, and later updater engine/control composition. Nothing in this
unit enables maintenance in deployed configuration, implements migration/restore,
or sets `recoveryQuiescence: true`. P4 hosted acceptance remains separate.

## Optional private lifecycle binding

The API accepts optional bootstrap-only `MAINTENANCE`, `MAINTENANCE_APP_KEY`, and
`MAINTENANCE_INSTALLATION_ID`. With all absent, existing behavior is preserved.
Partial configuration, refused admission, authentication failure, and unavailable
transport fail closed. No default environment or resource configuration changes.

The binding targets `createMaintenanceService`, constructed with the pinned
installation, maintenance core's private execution capability and HMAC key. Its
only routes are POST `/private/maintenance/{admit,release,ambiguity,operation}` on
`https://maintenance.internal`. The distinct HMAC domain signs path, installation,
timestamp and exact request bytes. Bodies/responses are capped at 2 KiB. The client
races the entire request and body against ten seconds, rather than assuming a
service binding honors an abort signal. No retry can grant duplicate execution
after an uncertain admission.

Updater-only migration `0006_updater_execution_proofs.sql` adds a release hash to
the permit table. The API creates a random 256-bit proof inside the execution
transport closure. Its hash is stored atomically with admission; proof, epoch,
permit and installation must match before release/ambiguity operations. The
plaintext proof is neither persisted nor exposed to application handlers, status,
browser roles or operator recovery. The scoped environment removes the lifecycle
binding and its credentials. Normal release is possible only after the local
scope revokes its capabilities. Process death loses the closure; diagnostic
permit IDs cannot reconstruct its authority. Keep lifecycle requests out of logs.

Admission identities are immutable tombstones. Authenticated replay cannot
readmit an old identity or replace its proof. Release is idempotent and cannot
clear pending ambiguity. Timestamp bounds limit authenticated request lifetime;
operation/permit identity and proof checks provide replay safety without an extra
nonce-table write per lifecycle call. No force-clear or general operator release
endpoint exists. A caller holding the private signing key and an execution proof
is trusted runtime code, not a browser authorization boundary.

## Execution coverage

`runApplication` encloses HTTP authentication, routing, caught-error diagnostics,
legacy cron execution, scheduler authorization and scheduler job execution. Only
the existing pure `/health` and OPTIONS responses bypass admission. Admin updater
routes still authenticate against app D1 inside the permit. Independent updater
recovery remains outside this application boundary.

The original runtime context receives the scope's drain promise; handlers receive
a tracking `waitUntil` that includes nested registrations. Without a runtime
context, the wrapper awaits drain before returning. Existing scheduler budget
wrapping composes around scoped D1 statements/batches. Scheduler alarms load and
persist their own scheduling state outside application admission, and save the
successor before trying the scoped enabled predicate/job. A denied admission marks
the job paused, retains a future alarm, and can resume after reopening without a
manual restart. That housekeeping does not access app D1 or providers.

All production global provider fetch sites use explicit scoped transports.
Google identity/token, Calendar, Drive picker/proof/intake/upload, Discord API,
private interaction replies, attachment media, Resend and telemetry propagate the
environment through their helpers. Config-only Discord entrypoints retain a
scoped association for compatibility; production callers pass the environment
explicitly. Scoped environments preserve their transport symbol through scheduler
spreads. Raw D1, service, and namespace fetch capabilities are replaced before
handlers run. No global fetch monkeypatch is used. Pure password computation is
tracked but does not receive a mutation-ambiguity record.

The source audit verifies absence of global provider fetch calls outside the
transport and explicit environment propagation through shared provider helpers.
Direct helper invocations without an application execution remain supported for
unconfigured tests; callers must not use that fallback to bypass admission.

## Completion and bounded bodies

The scope tracks original provider/service calls, even when callers race them
against shorter deadlines. Responses are fully read into bounded buffers before
handoff/classification: external metadata 1 MiB, media 8 MiB, updater 16 KiB,
password/scheduler 64 KiB, document JSON 6 MiB (including 4 MiB base64 readback),
and document result 16 MiB. Existing tighter endpoint readers still apply. Requests
use manual redirects and a 45-second abort signal. An underlying provider that
ignores cancellation may keep a permit active; cancellation is not proof of
completion. These buffer bounds are not hosted CPU/memory acceptance evidence.

Only known synchronous Google token/Calendar/Drive and Discord mutation endpoints
accept their explicit terminal status codes. Drive resumable 308 acknowledges its
bounded upload request, not completion of the complete upload. Resend POST `/emails`
requires HTTP 200 plus its UUID receipt: this proves accepted dispatch, not future
email delivery. The exact bootstrap-pinned telemetry endpoint requires 204, which
the current collector returns after its D1 writes. Unknown endpoints, malformed
receipts, mutation errors, aborts and generic provider 202 remain ambiguous.

D1 constraint errors positively identified as `D1_ERROR: …: SQLITE_CONSTRAINT`
(or a constraint subtype) indicate a terminal SQL result and do not strand a
permit merely because an ordinary validation failed. This establishes call
completion, **not rollback of prior changes**. Other error shapes—including quota,
network, cancellation and uncertain acknowledgments—remain conservative unknowns.
The [workerd D1 implementation](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/d1-api.ts)
wraps failures in D1 errors; matching only that prefix is insufficient to establish
a terminal constraint result. Hosted error-shape acceptance remains required.

## Isolated document compute

`experiments/pdf-spike/compute-worker.mjs` forwards only to its compute queue.
Its runtime/validation/assembly operate on supplied bytes and their own queue
storage; they do not call providers or access app D1. The existing
`scripts/document-compute-config.mjs` preflight rejects bindings/secrets other than
the queue and proof-mode flag. Under that pinned isolation contract, compute
requests are tracked like password computation: a queued result can continue in
its own store without a permanently blocked application permit. Any subsequent
application continuation needs fresh admission and scoped D1/provider access.
This is not generic 202 success and is not applicable to arbitrary replacement
compute code or bindings. Preserve the preflight/isolation checks before enabling
the maintenance binding; this unit does not provision or deploy compute.

## Evidence, cost and remaining composition

Local verification: `node --test tests/application-maintenance.test.mjs
tests/updater-maintenance.test.mjs tests/platform-scheduler.test.mjs
tests/database-unavailable.test.mjs`, plus API TypeScript checking. New tests use
real separate SQLite files, actual private service requests, actual Worker and
scheduler entrypoints, caught constraint failures, retained provider callbacks,
delayed response bodies, denied alarms/reopening, and representative response
sizes. Existing provider helper tests remain compatible with disabled maintenance.

Normal execution retains two updater lifecycle row writes. Transport release
adds a primary indexed proof lookup; no polling/heartbeat/nonce writes were added.
Ambiguity rows are written only for uncertain outcomes. Nested scheduler calls
can hold separate permits. D1 row/index billing and permanent tombstone growth
still need deployment budgeting. No hosted D1, provider mutation, or deployment
was performed for verification.

The next composition must bind closed epochs to update jobs, backup/migration and
restore, and keep independent control available through maintenance. Orphan and
ambiguous executions remain fail-closed; there is no operator force-clear or
complete generic provider readback implementation. Runtime lifecycle proof
ownership must remain private. This candidate is application execution integration,
not an accepted end-to-end updater or live maintenance enablement.
