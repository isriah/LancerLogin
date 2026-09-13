# Hour review/report contracts

## WU-105 selector prerequisite

`GET /admin/hours/member-choices` returns `{items,nextCursor}` behind current active `hours.manage`/Admin authorization and module enablement. Each item contains only `{id,label,externalId,active}`. `id` is the internal roster identity used by staff entry APIs; `externalId` is a string preserving leading zeroes and helps distinguish duplicate names. No contact, provider, dashboard profile or attendance information is selected.

List parameters: `active=true` (default), `false` or `all`; literal case-insensitive substring `q` over name/external ID (maximum 100 characters); `limit` default 50/maximum 100; `after` opaque ID cursor (maximum 128 characters). Ascending internal-ID order is a live cursor view. Unknown/repeated parameters reject. `GET /admin/hours/member-choices/:id` returns one minimal item, including archived members, for retained entry/history labels; no query parameters. Foreign/missing identities return 404. Authorization is fenced in the row query and checked again before return.

`GET /admin/hours/reopen-windows/:id` returns the existing staff window fields plus computed `active` (`!revoked && startsMs <= now && expiresMs > now`). It supports bounded authoritative create/revoke readback without scanning all window pages. Detail rejects query parameters and returns 404 for missing/foreign IDs.

Prerequisite verification: actual local D1 through production Worker routes, including minimum projection, duplicate-name/leading-zero IDs, archive filters, literal search, pagination/bounds, foreign scope, explicit grant/module checks, mid-read revocation, exact expiry and revoke readback. API/shared typechecks passed. These are local tests, not development-deployment evidence.

## Correction intake and attribution

`requestSelfAssertedHourCorrection(db, installation, input, now?)` and `requestLinkedDiscordHourCorrection(db, installation, verifiedDiscordUserId, input, now?)` are server-only domain functions. There is no public HTTP endpoint, Discord command, member history browser or member direct-edit route in this unit. Future adapters must provide admission/rate limits and authenticate signed Discord guild/user context before calling. New Discord intake additionally fences the current active pairing inside the insertion transaction.

Input is `{memberId, receiptId?, activityId?, serviceDate?, message, idempotencyKey}`. The public `memberId` is the external roster ID string, including leading zeros; Discord input excludes it. IDs are at most 128 characters; message is 1–4000 characters; service date is a real four-digit calendar date. Keys are 16–128 characters, stored as a hash with a normalized-payload/context fingerprint and scoped to installation/channel. Channel and attribution are fixed by the server entry point, never request flags.

Intake returns exactly `{accepted:true,reference}` after persistence. Identical retries return that immutable acknowledgement, including after resolution or pairing changes; changed input with the same key conflicts. Module disablement still blocks intake. Unknown member/receipt/activity claims receive the same persisted acknowledgement shape. Receipt/activity claims are never searched to disclose another entry. A current active member match is retained privately for referential integrity; public claims remain `self_asserted`, even when a roster ID matches. Discord requests retain `linked_discord` attribution. Neither label makes the correction accurate or approved. No names, contacts, current entry details or private staff notes appear in member acknowledgements.

Original claims, message, attribution, requester reference and idempotency metadata are immutable. Resolution is terminal. Further clarification requires another request; no automatic reopening or retry mutation is implemented.

## Staff inbox and resolution

All routes require an active current Admin or explicit `hours.manage` grant with Hour Tracking enabled. Operator alone has no access. Reads fence authorization in SQL and check it again before returning.

- `GET /admin/hours/correction-requests`: `{items,nextCursor}`, ascending opaque ID, `status=open` default or `resolved|all`, optional internal `memberId`, `limit=50` maximum 100, `after` at most 128 characters. No public projection is reusable from these private staff rows. Key hashes/fingerprints are omitted.
- `GET /admin/hours/correction-requests/:id`: private original request fields and `resolution` (or null), with no query parameters.
- `GET /admin/hours/correction-requests/:id/history`: bounded received/resolved events (at most two), `nextCursor:null`. It does not expose entry history to members.
- `POST /admin/hours/correction-requests/:id/resolve`: `{revision:0, action, note, entryId?, entryRevision?, correction?}`. Note is required, 1–4000 characters. `acknowledged` and `dismissed` optionally pin an explicitly matched entry and current revision; both matching fields must be supplied together. `corrected` and `voided` require both. `corrected` accepts WU-102 correction fields in the nested `correction` object, excluding revision/reason; review metadata supplies those. `voided` rejects correction fields.

Successful resolution returns `{id,revision:1,status:"resolved"}`, with `{entry:{id,revision,status}}` for an applied change. Refresh detail after uncertain responses; a repeated resolve conflicts rather than applying twice. Matching does not upgrade the original attribution. An acknowledgement pins the reviewed immutable entry revision even after later edits. An applied correction/void uses WU-102's same transaction for entry, immutable entry revision, request transition, resolution and audits. Current grants, expected request/entry revisions, catalog/member references, overlap constraints, immutable clock zone and exact void timing remain enforced. Resolution notes and original messages are excluded from audit metadata.

## Counted-minute reports

`GET /admin/hours/reports` requires inclusive `from` and `to` stored service dates. Optional filters are single internal `memberId`, `activityId`, `categoryId`, `teamId`. `groupBy=member` (default), `activity`, `category` or `team`; `limit=50` maximum 100 and an opaque `after` cursor paginate groups. Unknown/repeated parameters reject.

Response: `{from,to,groupBy,teamAttribution:"primary",totals:{minutes,entryCount,distinctParticipants},items:[{id,minutes,entryCount,distinctParticipants}],nextCursor}`. The team group may have `id:null` for activities with no primary supported team. IDs resolve through existing private catalog/member selectors; report rows contain no contacts or task notes. Totals are for the complete filtered period, independent of the group page. All aggregates use one D1 read snapshot. Counts include only current `counted` entries; voided history remains stored. Minutes are integers; a partial report with unsafe/non-integer totals fails closed. Distinct participants are calculated over the full matching set, never by adding group participant counts.

An overnight contribution belongs entirely to its stored start service date. Team attribution uses `hours_activities.team_id` only; partner-team associations do not duplicate or allocate hours. These are explicit technical reporting defaults, not compliance claims. The 3660-date request span bound is an engineering query safeguard, not retention, eligibility or the award's reporting-period policy. Older history remains available through another explicitly selected period. Page requests are separate live snapshots, so concurrent edits may change later pages; each response's totals and groups are internally coherent.

## Persistence and verification boundaries

Migration 0034 adds immutable request and terminal resolution tables, indexes and deferred scoped foreign keys. Schema 19 installation backups include both tables in the existing single read batch; validation rejects broken request/resolution/member/revision graphs before any destructive statement. Schema 18 and earlier backups initialize empty review tables. Full installation replacement is the explicit deletion exception. Ordinary attendance deletion/restoration does not touch these tables. Module disablement and roster archive preserve them. Requester identities, and current/prior/voided entry identities reached through resolution history, prevent destructive roster deletion; archive instead.

The migration uses trigger `WHEN` predicates and `BEGIN SELECT RAISE(...); END` without CASE bodies. The focused local D1 test executes 0034 through pinned Wrangler's actual SQL splitter. That proves local execution only, not Cloudflare's hosted SQL import parser. General application SQL export/import recovery remains a separate P6 acceptance item; the narrow synthetic recovery helper is not an application recovery parser.

Focused tests import production services/Worker routes into local D1 and cover idempotent concurrent intake, unknown claims, current pairing fences, attribution/privacy, competing resolution, overlap/stale/audit rollback, immutable history/receipts, coherent reports and backups under injected mutations, foreign access, archive/delete protection, disablement and schema compatibility. No provider calls or hosted resource changes occur. Public adapter abuse controls, public/Discord interaction testing and hosted CPU/query-plan measurements remain future work.

Candidate gates after consuming WU-108: `verify:api` passed 60 JavaScript and 130 TypeScript tests plus API/shared typechecks; `verify:migrations` applied all 34 migrations on fresh local D1; `verify:provisioning` passed 73 tests plus template checks. Independent source review found no material blocker. These results do not prove hosted migration import, deployed request handling or development acceptance.
