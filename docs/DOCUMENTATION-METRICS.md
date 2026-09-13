# Private structured metrics

Dependencies: current Documentation authority, Hours activity identity and initiative contracts (WU145/147). Manual metrics require both modules and current Documentation management or active Admin. They require no provider call, Hours entry, minimum participants, claim or artifact. This is a bounded P4 metadata backend; claim/evidence relationships, UI, files and packets remain subsequent required work.

A metric is a staff-recorded value with explicit kind, unit, inclusive reporting period, source, method and measured/estimated basis. Kinds are person-hours, participants, interactions, reach, outcomes and other. Kind is descriptive classification: participants does not establish unique people, reach does not establish measured impact, and person-hours does not alter or derive from Hours accounting. No aggregation endpoint, implicit unit conversion or initiative rollup is provided. Standalone metrics are permitted and are not automatically substantiated claims or award compliance.

## API and technical defaults

Prefix `/admin/documentation/metrics` uses the existing signed session, JSON/CORS and sanitized error boundary. Notes and participant/hour summary toggles do not disable independent metric management. Module disable makes routes unavailable while preserving records.

- GET prefix: `{metrics,next}`, using opaque after-ID, limit1-50 (default25), archival=true to include archived records. Default lists active metric records, including records whose retained contexts have become ineligible.
- POST prefix: `{title,kind,value,unit,periodStart,periodEnd,source,method,basis,activities?,initiatives?}`. Associations default empty. Returns201 `{metric}`.
- GET `/:id`: `{metric,activities,initiatives,readOnly}`. Each activity association is `{activityId,title,revision,eligible}`; initiative association uses initiativeId. Eligibility, titles, metric metadata and current authority share one SQL snapshot. No roster identities or private Hours descriptions are returned.
- PATCH `/:id`: `{revision,...changedFields,archived?}`. Each supplied association array fully replaces that context type; omission preserves it. Returns200 `{metric}`. Archived records accept only `{revision,archived:false}` before a separate edit. No hard-delete route exists.
- GET `/:id/history`: `{metricId,authorUserId,createdAt,revisions,next}`. Integer after-revision cursor with the same page limits. Every revision contains all metric fields, actorUserId, createdAt, activities and initiatives. Membership is immutable; context titles, context revisions and eligibility are explicitly current metadata, not historical snapshots. Historical links are the only lookup authority for those current labels. `next:null` marks the final page.

Metric DTO: `{id,title,kind,value,unit,periodStart,periodEnd,source,method,basis,archived,revision,authorUserId,createdAt,updatedAt}`. Immutable creator/creation provenance survives edits and inactive authors. Each successful mutation appends a complete field/membership revision and an audit with fixed action/target only; private text is not copied into audit metadata.

Technical limits: title1-200, unit1-80, source1-2000 and method1-4000 UTF-16 code units; plain text, nonblank, no controls except tabs/newlines. URLs may appear as text but are never fetched. JSON bodies are bounded to60000 UTF-8 bytes. The value must be a decimal string with up to15 integer and6 fractional digits, optional minus sign, and no exponent, plus sign, leading zeros, whitespace or negative zero. Supplied scale is preserved exactly (`1.0` and `1.00` remain different representations of the same number). No binary floating-point conversion is performed. Signed values permit outcome deltas; kind does not silently constrain or reinterpret the value. Dates must be real ISO calendar dates between1900-01-01 and9999-12-31 inclusive; periodStart must not exceed periodEnd. These are technical defaults, not an official reporting calendar or award rule.

Association inputs are `activities:[{activityId,revision}]` and `initiatives:[{initiativeId,revision}]`, with at most100 combined links and no duplicate within a type. New activity links require an active impact-relevant activity at the supplied revision. New initiative links require an active initiative at its supplied revision, including an empty initiative. No automatic expansion into initiative activities occurs. Retained links survive context archival/relevance loss, remain readable and removable, and do not block independent metric edits. Their current eligible flags identify the change. Future packet/claim selection must apply its own reviewed relevance policy; this backend does not imply permission to publish an ineligible context.

Current metric revision, active account/grant/modules, new-context eligibility/revision and the combined association bound are checked atomically in the mutation statement. A uniquely admitted request audit gates subsequent membership/history statements in the same D1 transaction. Conflicts cannot partially replace associations or append history. Read/history queries include current authority in their SQL snapshot.

Invalid input400, inactive/absent session401, missing module/grant403, unavailable record404, stale mutation or changed association/authority409, unsupported method405. Reload/review after conflicts; clients must not retry uncertain writes automatically. Plain text must be rendered as text, not HTML.

## Backup and evidence

Migration0042 adds six installation-scoped tables: metric headers/revisions and current/revision links for activities and initiatives. Foreign keys retain real existing identities without polymorphic references. Portable backup23 includes all six; versions1-22 normalize empty metrics. Restore validation rejects decimal/date/type violations, cross-installation or missing references, duplicate/missing revisions/links, creator/latest-state inconsistencies, combined association overflow and edits across an archived revision other than pure unarchive. It preserves inactive historical actors. Attendance-only restore leaves metric records intact. Backup validation checks structural consistency, not cryptographic authenticity of an edited backup.

The local raw recovery graph now pins42 migrations/70 tables with exact-scale synthetic metric fixtures. Local test success does not upgrade prior hosted recovery evidence. Portable transient-authority exclusions and external-effect restore guards remain unchanged; database backup does not copy/reverse Drive binaries.

Focused commands: `node --test tests/documentation-metrics-d1.test.mjs tests/application-recovery-spike.test.mjs tests/foundation.test.mjs`, `npm run verify:api`, `npm run verify:migrations`. Tests use synthetic local D1 data; coordinator integration and approved hosted schema42/API acceptance remain separate.

## Staff dashboard (WU-150)

The Metrics view inside Activity Documentation supports private list/create/edit,
archive and pure-unarchive, cursor paging and immutable history. It uses the same
Documentation-only Staff/Admin access as notes and initiatives. Notes and summary
section toggles do not disable manual metrics. Values stay decimal strings through
text input, validation, requests, readback and history; trailing zeros are retained.
No conversion, summation, inferred Hours total or automatic claim is introduced.

Staff explicitly supply title, kind, value, unit, inclusive period, source, method
and measured/estimated basis. Activity and initiative selections are independent,
paginated, optional and limited to 100 combined associations. Retained ineligible
contexts remain labeled, readable and removable without blocking independent metric
edits. Unavailable new draft links must be removed before saving. History presents
all recorded fields and membership with current context labels/eligibility, not
historical name snapshots or raw actor/member identities.

Generation-fenced reads and a separate mutation guard follow the existing workspace
pattern. Focus refresh hides private content and cannot unlock an outstanding write;
revocation clears drafts and records. Conflicts and uncertain responses require
explicit reload and review of saved state alongside preserved drafts. Archive is
disabled while dirty, with explicit save/discard guidance. Closing a dirty editor
is labeled as discarding the draft. No mutation retry runs automatically.

Local verification: `npm run verify:dashboard` and
`npm run test:browser -- metrics-workspace.spec.ts`. The 18 synthetic browser cases
cover roles, exact decimal scale, period validation, CRUD/history, both context
types, pagination/retention, section independence, conflicts/uncertain readback,
delayed read/write access changes, the combined association bound, and keyboard
focus. Custom-brand light/dark 1280x900 and 390x844 screenshots were inspected.
The shared font, spacing, radius, semantic color and 44px control patterns are
reused; no UI-standard exceptions. Hosted acceptance remains a coordinator step
with the accepted schema42 backend. Claims, artifacts/files and packets remain
subsequent required work.
