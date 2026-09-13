# Public Hours HTTP adapter

WU-111 provides anonymous submission-only HTTP adapters around `submitSelfAssertedHours` and `requestSelfAssertedHourCorrection`. Entering a member ID is self-assertion, not authentication. No staff session or caller flag grants historical/member-management access through these routes. No roster search, receipt lookup, member history, public report or direct edit route exists.

## Consumer contract

All responses use `Cache-Control: no-store`. POST requests require JSON and an exact `Origin` equal to the configured form origin; absent, `null` and foreign origins reject before database/domain work. The API uses its server clock and fixed installation scope, never caller timestamps or installation IDs. The Pages `/api` proxy removes `/api` before forwarding the paths below.

| Route | Response / input |
| --- | --- |
| `GET /public/hours/context` | `{available:true,timeZone,today,earliestServiceDate,reportingDays}` or `{available:false}` when unavailable/disabled configuration has no submission context |
| `GET /public/hours/categories` | `{items:[{id,name,mode}],nextCursor}`; active categories only |
| `GET /public/hours/teams` | `{items:[{id,name,number,program}],nextCursor}`; active teams, optional literal case-insensitive `q` over those display fields |
| `GET /public/hours/events` | `{items:[{id,categoryId,title,serviceDate}],nextCursor}`; active event/category pairs eligible on the request's installation-local date, including current past-event reopening; optional `categoryId` and exact `date` |
| `POST /public/hours/entries` | Existing public accounting input below; 201 original persisted receipt, including an identical retry |
| `POST /public/hours/correction-requests` | `{memberId,receiptId?,activityId?,serviceDate?,message,idempotencyKey}`; 202 exact `{accepted:true,reference}` acknowledgement |

Lists default to 50/max 100 rows, ascending opaque ID cursors (`after` max 128 characters). Team query max 100 characters. Unknown/repeated parameters reject. Public projection excludes staff assignments, contacts, attendance snapshots, private descriptions/location, historical claims, impact settings and provider configuration. Provider publication opt-ins do not control submission choices. Event titles/category labels/team display fields are consequently visible to form visitors and should be authored accordingly. Future events are excluded; reopening never exposes older team/task dates.

Entry input: string external `memberId` preserving leading zeros; `activityId` for an event, or non-event `categoryId`, `serviceDate`, and team-mode `teamId`; `startLocal`, `endLocal`, explicit boolean `endNextDay`; optional `startOccurrence`/`endOccurrence` (`earlier|later`) and `taskNotes`; mandatory `serviceDate` (including the displayed event date) and `expectedTimeZone` from the displayed context and `idempotencyKey` (16–128 characters). No client minutes, provenance, status, staff bypass, current revision or server time is accepted. The domain resolves active identity and enforces current module/catalog/settings/timezone/pairing-independent public eligibility plus database overlap constraints. Staff and Discord continue using their distinct existing entry points.

Receipt fields retain the existing snake_case contract: `id`, `activity_id`, `service_date`, `time_zone`, `start_local`, `end_local`, `end_next_day`, `start_occurrence`, `end_occurrence`, `start_ms`, `end_ms`, `start_offset_seconds`, `end_offset_seconds`, `duration_minutes`, `task_notes`, `created_at`. It describes only the original accepted submission, including after correction/void. There is no current-state readback. Keep the exact payload and random key in memory through an uncertain response and retry explicitly with those unchanged values. A deliberate new entry uses a new key. Losing the key/payload loses public receipt recovery; do not silently submit again. A correction request can instead describe the activity/date. Neither retry keys nor member IDs belong in URLs.

Entry-domain validation/conflict failures are deliberately combined as 409 `{error:"Unable to record these hours. Check your details or request a correction.",code:"submission_not_accepted",correctionAvailable:true}`. This includes unknown/inactive identity, overlap, stale zone/eligibility, invalid clocks and reused-key conflicts, without competing entry details. The form should validate clock syntax/folds locally using the same shared civil-time module, offer refresh/review and correction, and never infer another member's records from rejection. Boundary failures retain fixed 400/403/413/415 messages; admission returns 429 plus `Retry-After`, storage/configuration failure 503. No arbitrary provider/database error text escapes this adapter.

Correction claims remain explicitly unverified. Unknown member/receipt/activity claims receive the same persisted acknowledgement shape; there is no lookup to identify another contribution. Identical correction retries return the original acknowledgement even after staff resolution. No member-facing staff notes or resolution history are returned.

## Admission and request bounds

The streaming JSON reader rejects over 16 KiB before accumulating additional chunks, cancels overflow/stalled streams with an absolute ten-second deadline (408), checks declared size, decodes UTF-8 strictly and rejects malformed JSON. The domain receives a fresh trusted server time after body parsing, so a slow upload cannot retain an expired reopen window. Admission runs before body parsing/domain invocation so invalid identity and correction attempts also consume quota. Cross-origin rejects occur before admission. All bounds below are proposed tested engineering defaults, not measured hosted capacity.

| Policy | Source/minute | Source/hour | Installation/minute | Installation/day |
| --- | --- | --- | --- | --- |
| Mutation (entries and corrections together) | 30 | 300 | 300 | 5,000 |
| Read (context and catalogs together) | 120 | 1,200 | 1,200 | 20,000 |

Each attempt reserves four fixed UTC-window buckets in one D1 transaction. A named capacity check aborts/rolls back the entire reservation before domain invocation; quota-read/database failures fail closed. Quota and accepted entry persistence are separate transactions: failed validation consumes an attempt, while an admission failure cannot create an entry. Throttling can postpone receipt recovery but does not change its key or result. `Retry-After` reflects the latest exhausted applicable bucket expiry, capped at one day.

The installation clock retains a monotonic high-water mark. Up to five seconds of out-of-order request start times are allowed for ordinary concurrent async work; larger rollback fails 503. Expired counters are retained for this tolerance to prevent late requests recreating a deleted bucket. At most 64 expired rows are cleaned per admitted pass. Request times and capacities cannot be supplied by clients.

Subjects use purpose-separated HMAC-SHA256 with existing `SESSION_KEY` material, installation and daily epoch. Raw IPs, member IDs, retry keys and bodies never enter limiter records or audit metadata. Existing transient counters contain only fixed policy/scope labels, opaque digests, windows and counts. No additional external service or secret is installed by this unit.

## Ingress boundary and WU-112 dependency

WU-111 deliberately **ignores all incoming IP/forwarding headers** and places unverified ingress in one restrictive shared source bucket. Normal per-source acceptance remains open until WU-112; a shared classroom/network load test must not be represented as passing per-source throttling with this fallback alone.

Cloudflare documents that same-zone Worker subrequests derive `CF-Connecting-IP` from mutable `x-real-ip`, while cross-zone subrequests use a shared Worker address. `request.cf` exposes network metadata but does not document an immutable original-client identity assertion for this proxy path. Thus an unverified header is insufficient. Sources: [Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/), [incoming Request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/).

Approved follow-up contract: WU-112 owns authenticated Pages source assertions and API verification, serially after this unit. Derive a narrowly purpose/version-separated `HOURS_PROXY_KEY` from the existing API session secret; provision only that derived key to the exact existing Pages project. Never expose the API session key to Pages or a browser. Sign a bounded assertion containing version, timestamp, HTTP method, exact canonical API path/query, bounded-body SHA256 and source HMAC. Verify the MAC using WebCrypto, bound freshness and reject changed path/body/method; validate the exact Pages ingress/address provenance before signing. Assertions are transport metadata and must be removed before domain fingerprinting. Do not accept unsigned source digests. Missing/invalid assertions use restrictive fallback or fail closed according to that unit's frozen ingress policy. This file defines a follow-up boundary, not an implemented trusted-source interface or authorization to mutate secrets/resources.

## Lifecycle and evidence

Migration 0035 installs transient counter/clock tables regardless of module enablement. They are excluded from logical backups, so persistent backup schema19 is unchanged. Full installation deletion/replacement clears them by installation cascade; restoring does not resurrect obsolete throttling decisions. Attendance-only operations, roster archives and module disablement do not delete accepted hour receipts or correction requests. Disabled contexts do not expose catalog content and submissions reject. Ordinary expiry needs no scheduler.

Tests exercise production adapters and actual local D1 with pinned Wrangler migration splitting: projections, string IDs, anonymous route entry, origin/privacy failures, cross-channel races, exact retry after void, generic corrections, reopening/expiry, atomic quota races, clock ordering, streaming cancellation and backup exclusion/reset. Development hosted request/source behavior and per-source load acceptance remain separate from local verification. Public UI, Discord interactions, uploads and provider publication are outside WU-111.

Candidate verification: `verify:api` passed 63 JavaScript and 130 TypeScript tests plus API/shared typechecks; `verify:migrations` passed 35 fresh local migrations; `verify:provisioning` passed 73 tests plus template checks. Independent review identified the delayed-body expiry issue; its source recheck confirmed the absolute deadline and refreshed domain clock fix. The focused regression rejects a submission completed after reopening expiry. No hosted mutation, secret provisioning or deployment was performed by this work unit.


WU-112 adds authenticated Pages source partitioning; see [PUBLIC-HOURS-PROXY.md](PUBLIC-HOURS-PROXY.md). The public JSON contract is unchanged. Unverified traffic still shares the restrictive fallback. Successful hosted provenance/secret setup must be recorded separately from local verification.
