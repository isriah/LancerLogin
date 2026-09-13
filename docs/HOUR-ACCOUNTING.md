# Hour accounting backend

WU-102 supplies the shared entry domain and staff API. Normal submissions count immediately. Correction requests, aggregate reporting, public HTTP forms, Discord commands and provider delivery are separate units; no entry is an approval queue item.

## Settled behavior and technical defaults

An entry references WU-099's stable activity ID and a stable internal roster ID. Event mode selects an existing dated event. Team/task creation finds or creates the canonical category/date/team activity in the same transaction as the contribution. It copies the category's current relevance default and never creates catalog categories or teams. Entries do not affect attendance or publish anything.

Store elapsed duration in integer minutes. There is no break deduction or total-hours override. Count only `status=counted`; voids remain in history. Display code may round hours, but accounting never rounds minutes. Adjacent half-open intervals are allowed; overlapping counted intervals for the same member are rejected across activities and channels.

Creation snapshots the installation timezone. Store local start/end clock strings, explicit `endNextDay`, independently chosen fold occurrences, exact offset seconds and resolved epoch milliseconds. WU-101's `@lancerlogin/shared/civil-time` resolver rejects nonexistent/ambiguous times unless a fold selection is explicit. Positive duration, integral elapsed minutes and non-future completion apply to staff and members. Historical fractional-minute offset changes are rejected, not rounded; there is no arbitrary historical-year cutoff beyond the resolver's four-digit date contract.

Entry clock timezone is immutable, including staff corrections. It is separate from activity planning timezone; planned times do not constrain contributed hours. Once an activity has any current or prior entry reference, its service date cannot change, including after reassignment or void. Create another dated activity when needed. Title/location/planning edits remain independent.

The normal member window includes today and the preceding six installation-local dates. Settings may change this to 1–365 dates. A single past event or all past events may be reopened, default 24 hours, configurable 1–168 hours. Global reopening never opens historic team/task dates. Windows expire by request-time comparison and can be revoked; no scheduler is required. Staff use a separate trusted path that bypasses only historical-date/active-roster restrictions, not future completion, overlap, authorization or consistency checks.

These bounds are tested engineering defaults: 16 KiB JSON requests; 128-character identities/transport keys (keys require at least 16 characters); 4000-character task notes/reasons; 50-row default/100-row maximum pages; at most 64 simultaneously unexpired, unrevoked reopen windows. They are not measured provider limits.

## Trusted domain entry points

`submitStaffHours(db, installation, actorUserId, input, now?)`, `submitSelfAssertedHours(db, installation, input, now?)`, and `submitLinkedDiscordHours(db, installation, verifiedDiscordUserId, input, now?)` share one accounting implementation. Channel, attribution and historical staff access are fixed by the selected server function, never JSON flags. `now` is a server clock/testing seam and must never be populated from client input.

The future Discord adapter must verify the signed request and authorized guild before calling the linked entry point. The domain additionally resolves the existing pairing and rechecks that member's active status/current Discord ID at commit. This unit adds no Discord route/command or public HTTP entry point. Public inputs resolve an exact active external roster ID (string, preserving leading zeroes); staff inputs use an internal member ID and may reference archived members. The internal self-asserted function is not authentication and exposes no roster search.

Create input:

- `expectedTimeZone` must match the displayed installation zone. Staff HTTP create requires it; omission is supported only by trusted internal callers without prior draft context. Future public/Discord adapters must supply it. A mismatch returns 409 and requires reloading the clock context; it never overrides the server zone.
- `idempotencyKey` is mandatory. Future public adapters use a random transport retry key; Discord uses its interaction ID.
- Staff/public `memberId` follows the identity distinction above. Discord input must omit it.
- Select `activityId`, or non-event `categoryId`, `serviceDate` and team-mode `teamId`.
- `startLocal`, `endLocal` use the resolver's HH:mm/optional seconds/milliseconds format. `endNextDay` must be an explicit boolean. Optional `startOccurrence`/`endOccurrence` are `earlier` or `later`.
- Optional `taskNotes` defaults empty. No caller-supplied minutes, status, timezone, channel or attribution fields are accepted.

The minimal persisted receipt uses snake_case: `id`, `activity_id`, `service_date`, `time_zone`, local clocks/next-day/occurrence selections, start/end instants and offset seconds, `duration_minutes`, `task_notes`, and `created_at`. It contains no roster name, competing entry, current correction reason or provider identity. It describes the original accepted submission, not current accounting state. An identical retry returns this exact receipt after correction or void, without reading/disclosing private current state. Current staff authorization/module availability still applies. Reusing a key with another payload or actor fails generically. Keys are channel-scoped and hashed; receipts and revision snapshots reject database UPDATEs.

## Staff HTTP contract

All routes require a current active staff account with `hours.manage`, or Admin, and enabled Hour Tracking. Operator alone gives no access. Staff responses other than creation receipts use camelCase; no API here is safe for unauthenticated reuse.

| Route | Operation |
| --- | --- |
| `POST /admin/hours/entries` | Create via trusted staff path; HTTP 201 original receipt, including exact retry |
| `GET /admin/hours/entries` | `{items,nextCursor}`; filters `memberId` (internal), `activityId`, `status=counted/void`, inclusive `from`/`to`, `after`, `limit`; default includes both statuses |
| `GET /admin/hours/entries/:id` | Current entry, including revision, channel/attribution and saved timing |
| `PATCH /admin/hours/entries/:id` | Partial correction with mandatory current `revision` and nonblank `reason`; recalculates duration/overlap; returns `{id,revision,status}` |
| `POST /admin/hours/entries/:id/void` | Only current `revision` and nonblank `reason`; preserves exact timing/attribution; returns `{id,revision,status}` |
| `GET /admin/hours/entries/:id/history` | Paginated immutable snapshots/reasons/actions, ordered by revision; `after` is a revision cursor |
| `GET/PUT /admin/hours/entry-settings` | Read/edit `reportingDays`, `reopenHours`; GET also returns current `timeZone`/`today` for drafts; PUT requires current `revision` |
| `GET/POST /admin/hours/reopen-windows` | Paginated windows, or create with explicit `activityId` (null means all past events) and optional `durationHours` |
| `PATCH /admin/hours/reopen-windows/:id` | Current `revision` and `revoked:true`; create a new window to reopen again |

Entries/windows use ascending opaque-ID cursor order, not chronological ordering or snapshot pagination. Void is terminal; staff may create a replacement entry, and the prior record remains. Correction may change member/activity with a reason. To select a new canonical non-event activity on correction, send `activityId:null`, the new category/date/team fields and the intended clocks. Entry service date follows the selected activity. Conflict responses require explicit reload; no automatic mutation retry is implied. Existing selector APIs remain unchanged; a future staff entry UI needs an authorized roster-selector contract rather than exposing core roster routes.

## Atomicity and preservation

One D1 transaction includes any canonical activity insertion, the conditional entry mutation, audit, immutable revision snapshot and receipt. Every creating statement shares the live authorization/member/category/settings/timezone fence; stale corrections also fence the expected entry revision before activity insertion. A failed overlap, reference constraint or audit rolls back the entire transaction. Simultaneous same-key retries yield the stored original receipt; another payload using the same key never receives it. Database overlap triggers protect INSERT and UPDATE, and the activity-date trigger protects concurrent catalog edits. No application read-before-write check is the sole integrity boundary.

Mutation audit metadata includes only revision, not task/reason/member details. Reasons are retained in the staff-only revision records. Both current and prior member/activity references are protected by deferred, non-cascading composite foreign keys. Single-member and bulk roster deletion return archive guidance; concurrent history creation rolls back deletion/user unlinking. Roster merge/replace/restore preserves existing internal identities and archives omitted members. Attendance-only deletion/restore leaves accounting untouched.

Migration 0033 installs all five accounting tables and integrity triggers regardless of module enablement. Existing installations receive settings defaults; first-Admin setup seeds settings transactionally. Backup export reads all selected tables in one D1 snapshot batch, so concurrent submission cannot tear an entry away from its revision/receipt. Backup schema 18 includes settings, windows, current entries, complete revisions and idempotency receipts. Restore validates reference graphs, exact clock/duration calculation, copied receipt content, immutable provenance, revision continuity, and non-overlap before destructive statements. Backups through schema 17 restore empty accounting with default settings. Full installation replacement/deletion intentionally replaces/removes accounting; this is the explicit exception to incidental-deletion safeguards.

Backup fingerprints are checked structurally; the original transport payload is intentionally not retained to rederive its hash. The receipt is checked against the original revision snapshot. Restored clock data must be supported by the destination runtime's timezone data; incompatible snapshots fail closed rather than being recalculated silently.

## Verification boundary

Focused tests import production modules and run local Miniflare D1. Measured staff create and canonical task create each execute 12 D1 statements in the domain; staff HTTP create measured 14 including its principal lookup and route capability gate. The installation backup reads 40 tables in one batch, plus the principal lookup and export audit. This does not measure hosted CPU or deployment acceptance. Tests cover migration preservation, integer accounting, cross-channel/same-key races, overlap and adjacency, current authorization/pairing fences, canonical identity, windows/expiry, corrections/void receipts, timezones/DST/year zero, history-only roster protection, audit rollback, immutable SQL rows, backup validation/roundtrip and fresh/legacy setup.

The development-bundle path passes full manifest-copied migration SQL to Wrangler migrations apply. Accounting fixtures use the pinned Wrangler local splitter. Hosted D1 has a separately evidenced trigger parsing constraint; migration 0033 uses conditional `RAISE ... WHERE` statements to accommodate it. See [D1 migration transport](D1-MIGRATION-TRANSPORT.md) for the failed hosted attempts, safe rewrite rationale and local/hosted verification distinction. `scripts/development-recovery-spike.mjs` is restricted to its fixed synthetic disposable schema; its semicolon splitter is not a general application-dump parser. General application export/import recovery remains a later P6 acceptance task.

Candidate gates passed: `npm run verify:api` (55 JavaScript tests, 130 TypeScript tests and API/shared typechecks), `npm run verify:migrations` (33 ordered migrations), and `npm run verify:provisioning` (73 tests plus template guard).

No provider calls, hosted migrations, deployments, public adapters, correction-request workflow, aggregate reports, imports or UI are included here.
