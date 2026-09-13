# Shared platform scheduler (WU-092)

Dependencies: WU-088 module contracts, WU-089 current active staff identity, and explicit coordinator approval of the exact development namespace before deployment. This implementation adds an opt-in runtime; no external resource or deployment configuration is changed by this work unit.

## Activation boundary

The proposed namespace belongs to the existing approved development API Worker. It requires the exported class `PlatformScheduler`, binding `PLATFORM_SCHEDULER`, a SQLite migration such as `{ "tag": "platform-scheduler-v1", "new_sqlite_classes": ["PlatformScheduler"] }`, and variable `PLATFORM_SCHEDULER_MODE=durable`. Use only the singleton name `primary`. Namespace identity must be recorded outside code after approved creation. The default bootstrap produces `triggers.crons: []` and no DO migration or binding. The explicit private-identity opt-in in [DEVELOPMENT-BOOTSTRAP.md](DEVELOPMENT-BOOTSTRAP.md#optional-development-scheduler-wu-095) now supports initial namespace capture and later redeployment with a verified, pinned identity. It preserves the fixed binding/migration and rejects attempts to silently remove an activated scheduler.

Without durable mode, the existing cron entrypoint retains its existing cadence. With durable mode, all cron delivery is suppressed even if the namespace binding is accidentally missing; a misconfiguration must fail closed instead of creating a duplicate scheduler. Bindings alone do not start jobs. An Admin explicitly starts the scheduler after deployment acceptance checks.

## Controls and durability

`GET /admin/scheduler` returns only enabled state and fixed job IDs with next/last timestamps and generic outcomes. `POST /admin/scheduler/start` and `/stop` require an empty JSON object. The API and object both reload the active signed Admin identity; Staff and Operators cannot operate it. Existing first-party JSON/CORS rules apply. Successful mutations are audited by the API. Audit and DO state cannot be one cross-service transaction: an audit failure can report failure after the requested scheduler transition, so inspect status before retrying.

The object serializes controls and alarms. Stop waits for the current family to finish, then removes the alarm; it cannot retract a provider request already sent. It does not delete provider queues/mappings or scheduler outcomes. Status requests never rewrite alarms. Repeated start preserves an existing alarm; if a prior mode-off deployment removed the alarm while retaining enabled state, an explicit start restores the missing alarm using the preserved job timestamps. It does not reset checkpoints or replay each missed tick. A disabled-to-enabled transition schedules future passes, not one pass per missed tick. Daily telemetry runs every 24 hours after start, with the existing consent and endpoint gates; legacy cron mode continues its 03:00 UTC trigger.

Each alarm runs one due family. It saves that family's next timestamp and a successor alarm in one SQLite-backed storage transaction before external work. Start/stop state and alarm changes use the same transactional boundary. Failure or runtime interruption cannot trap all later families behind one poisoned family. Provider retry state is retained; the next ordinary family pass retries eligible operations. An interrupted pass can retain `running` until its next attempt. Outcomes describe completion of the pass, not guaranteed delivery of all queued operations; existing provider queue status remains authoritative.

The Discord channel family reloads central Discord enablement and verification metadata before loading credentials or reconciling messages. Disabled, absent or unverified connections intentionally complete an empty pass (`ok`); this means the scheduled check completed, not that Discord delivered anything. These eligibility reads remain inside the existing family admission budget. Enabled credential/decryption, database and provider failures remain `failed`. Explicit manual Discord status/setup operations retain their actionable errors. WU-110 regression tests exercise production scheduler/Worker imports with real local SQLite, zero-request skips, current enablement changes, manual errors and failure isolation; hosted re-testing is separate.

Cloudflare alarms are at least once, including automatic retries after thrown errors. Application exceptions become generic `failed` status; storage/runtime interruption can still trigger platform retry. The durable timestamp prevents immediate replay of a claimed tick, but external side effects and local persistence cannot be atomic. [Alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/) and [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Bounded execution

Every durable family receives a fresh admission budget shared by its eligibility predicate and execution. It refuses the 33rd D1 statement and 13th external provider fetch **before issuing it**. Batch statements are conservatively charged individually; the native D1 batch receives the original statements. A family therefore admits at most 44 counted statement/request operations. Provider redirects are refused, retries count individually, provider requests time out after ten seconds, and Discord delays over five seconds return to durable retry instead of occupying the singleton indefinitely. This admission ceiling complements row/output bounds; it is not a claim about measured deployed CPU. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [DO CPU/storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

| Family | Per-pass work |
| --- | --- |
| Hours Google Calendar | One reviewed owned publication/cleanup operation; see [Hours publication](HOURS-PUBLICATION.md) |
| Hours Discord Calendar | One reviewed owned publication/cleanup operation, with durable retry only |
| Attendance Google Calendar | One existing eligible operation, including token refresh/conflict recovery |
| Attendance Discord Calendar | One leased operation, preserving provider mappings and generation fencing |
| Discord channel management | Existing kiosk status and guidance reconciliation, within shared admission budget |
| Attendance notices | One eligible meeting; delivered/ineligible records excluded before bounded selection |
| Notice expiry | One due tracked message, with retry ordering by update timestamp |
| Attendance anomalies | One eligible meeting; at most 1,001 candidate member rows, reject over 1,000 |
| Telemetry | One consent-gated daily submission |

All non-telemetry families run at five-minute intervals. Scheduler tick history is not replayed; existing eligible provider/domain queue work remains eligible. Notice and anomaly failures move their update timestamp so another eligible meeting can proceed next pass. Pending notices left by interrupted delivery become eligible after five minutes.

Scheduled notices materialize at most 101 linked absent members and reject over 100, content over 2,000 characters, or recipient JSON over 64 KiB before posting. They never silently truncate an audience. Recipient persistence uses one `INSERT ... SELECT ... FROM json_each(?)` and one status update, with four recipient-insert parameters, independent of audience size. Oversized audiences require a future explicitly designed multi-message delivery outbox; this unit does not invent split-message semantics. Ordinary manual resend behavior retains its existing identity and recipient behavior.

Scheduled notice sends add a deterministic nonce with `enforce_nonce`. Discord only deduplicates this nonce within its recent window, so a crash followed by retry later can still duplicate a message. Exactly-once remote delivery across arbitrary crashes is **not** claimed. Manual forced resends do not receive this deduplication nonce. [Discord message limits and nonce semantics](https://docs.discord.com/developers/resources/message).

The limits prevent unbounded API-call loops, not expensive database scans across arbitrarily large installations. D1 query limits still apply; a failed bounded pass retries later. Free-plan CPU, large real provider responses and total daily quotas require development telemetry acceptance before scale claims.

## Future module jobs

Registry descriptors in `platform-modules.ts` do not start fake handlers. Add a real release-owned bounded handler only when its domain implementation exists. Its `enabled` predicate must call `requireModuleEnabled` against current D1 state and return false for a disabled module. The domain operation must recheck module/activity eligibility in its own mutation/lease predicate, and reuse the admission budget for every provider request. Disabled dispatch records `paused` and advances its cadence. Enabling a module must never synthesize historical publishing/intake work. Staff-authorized delayed actions must additionally reload current grants. No request may supply job code, module IDs, provider URLs, resource IDs or arbitrary scheduling intervals.

## Verification and acceptance

Run `node --test tests/platform-scheduler.test.mjs tests/platform-scheduler-delivery.test.mjs tests/platform-scheduler-workerd.test.mjs` and `npm run verify:api`. The root test glob and the focused `test:api` command both include these files.

Local coverage includes concurrent starts/alarms, failure isolation, module pause, active authorization, no cron fallback in durable mode, stop/restart, a populated real SQLite notice backlog with twenty recipients and measured statement counts, retry nonce stability, and actual local workerd SQLite alarms surviving runtime replacement. Synthetic callbacks and mocked Discord responses do not establish successful provider or deployed scheduler operation.

Development acceptance still requires approved namespace creation/configuration, signed Admin controls and unauthorized rejection on the hosted origin, scheduler operation after browser closure/redeployment, existing provider queues under bounded dispatch, telemetry opt-in/off checks, and real CPU/error telemetry. No production activation, source change, data migration or Pi update is authorized by this document.
