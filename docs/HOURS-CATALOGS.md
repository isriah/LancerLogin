# Hour Tracking catalogs and dated activities

WU-099 implements staff catalog/planning records, not hour accounting or provider publication. All endpoints below require a current active account, an enabled Hour Tracking module, and either Admin or an explicit `hours.manage` grant. An Operator role alone provides no access. Responses are staff-only and must not be reused as future public payloads without a separate narrow field allowlist.

## Product decisions and engineering defaults

Categories are editable and choose `event`, `team`, or `task` entry mode. The initial categories are Event, Team Support, and Other Service; Impact relevance defaults off. A new activity copies its category's current relevance default unless explicitly overridden. Later category edits never rewrite existing activity relevance. Mode can change only while no activity references the category, including archived activities.

An event is an independent dated activity with planning fields; there is no mandatory parent event/session hierarchy. Multiple independent events on the same date are allowed. A stable `(installation_id, activity.id)` is the shared identity for future hour entries and Activity Documentation. Those later units must reference it rather than duplicate event identities.

The accepted **technical grouping default** for non-event work is one activity per category + service date, adding the supported team identity in team mode. Per-entry task descriptions belong to the later hour-entry unit. Category, mode, team identity and the non-event service date cannot change after creation. The uniqueness constraint includes archived records: find/reopen the original activity instead of creating a duplicate. Event service dates may be edited; the activity ID stays stable.

Supported teams retain a text team number (including leading zeroes), name, organization, program and historical descriptors. These fields describe staff-entered history and make no verification, compliance or award claim.

## HTTP contract

Collections are `/admin/hours/categories`, `/admin/hours/teams` and `/admin/hours/activities`.

- `GET collection`: `{items: [...], nextCursor: string | null}`. Default limit 50, maximum 100; `after` is the prior response's cursor. Results use ascending opaque ID order, not chronological order. `archived=false` is the default; `true` returns archived records and `all` returns both. Unknown or repeated collection filters fail validation.
- `GET collection/:id`: one current staff record, including archived records.
- `POST collection`: create; returns HTTP 201 `{id, revision: 0}`.
- `PATCH collection/:id`: partial edit with mandatory numeric `revision` from the last read; returns HTTP 200 `{id, revision: previous + 1}`. Omitted writable fields retain their previous values. `archived: true/false` archives/reopens. There is no hard-delete endpoint.

Activities additionally accept `from`/`to` inclusive `YYYY-MM-DD` filters, `mode`, `categoryId`, and `teamId`. Filtering does not change ID pagination order. Listing is a live cursor view, not a frozen snapshot. Clients must fetch a detail after a mutation to load its current state; conflicts require an explicit reload before retry, and POST has no retry/idempotency token.

All records return `id`, `revision`, `archived`, `createdAt` and `updatedAt`; the installation ID is omitted. Writable fields:

| Collection | Fields |
| --- | --- |
| Categories | `name` (required, 100 characters), `mode` (required: event/team/task), `impactDefault` (boolean, default false) |
| Teams | `name` (required, 150); `number` (text, 32), `organization` (200), `program` (100), `historicalDescriptors` (4000), all optional and default empty |
| Activities | `categoryId` (required), `serviceDate` (required unless copied from attendance), `teamId` (required only for team mode); `title` (150, defaults to category/date or source title), `description` (4000, default empty), `location` (300, default empty); paired nullable `startsAt`/`endsAt`; `impactRelevant` (boolean); `responsibleStaffIds` (up to 10 unique active local user IDs), `partnerTeamIds` (up to 20 unique active local team IDs); optional creation-only `sourceMeetingId` for event mode |

Planning times are explicit ISO date-times with an offset or Z, at most millisecond precision. End must follow start; start and the final included millisecond must fall on `serviceDate` in the saved `planningTimeZone`. An exclusive end exactly at the next local midnight is allowed, including 23/25-hour DST days. Multi-day source timing is rejected unless explicit per-day planning times are supplied; it is never clipped. Each activity snapshots the current organization time zone at creation as immutable `planningTimeZone`, even when initially untimed. Later organization-zone changes do not reinterpret existing activities or invalidate their backups. This is a tested technical data-preservation default, not an hour-entry clock policy. They are planning metadata, not recorded hours. Strings are trimmed; blank optional descriptions/team metadata are supported. The request JSON limit is 16 KiB; identities are bounded to 128 characters. These are tested engineering bounds, not measured provider limits.

Activity list rows also return `mode`, copied relevance and any planning source snapshot. Detail adds `responsibleStaffIds`, `partnerTeamIds`, and (when linked) `sourceState` (`current`, `changed`, `unavailable`). These fields are staff-only. Current source state is calculated on detail reads, not cached or included in collection rows. Activity responses do not embed staff profiles or team descriptors.

New activities require an active category and active primary/partner team. Existing inactive staff/archived team links can be retained while correcting an existing activity, so archiving does not strand historical records. Newly added links must be current and active. Existing activities can be edited when their category is archived; the category's revision is still checked at commit.

Errors use the existing API error shape: 400 invalid input, 401 unavailable session, 403 missing capability/disabled module, 404 absent record/source, 405 unsupported method, 409 stale revision/reference/access/identity conflict, 413 oversized body. No response implies an external publication or notification.

## Attendance detail reuse

Creation accepts an existing non-test meeting ID in `sourceMeetingId`. The WU-100 planning selector below supplies that identity through a named choice; Staff remain excluded from the core meeting/admin routes.

Creation copies only title, service date, startsAt and endsAt. The source has no location field; description and location therefore start empty unless explicitly supplied. The immutable snapshot contains exactly title, serviceDate, startsAt and endsAt; the opaque source ID is stored alongside it. Attendance notes, roster, percentages, absence data and private report fields are never selected or copied. Independent edits to the activity do not update attendance or its snapshot. Source title/time changes are reported as `changed`; soft/hard deletion as `unavailable`.

There is deliberately no foreign key to meetings: attendance-only delete/restore cannot null the installation identity or cascade module history away. The snapshot records what was read at creation; a simultaneous source edit/deletion can make the new record immediately stale, which detail readback reports. No ongoing synchronization occurs.

## Authorization, integrity and backups

Each write uses one D1 transaction containing the conditional parent mutation, audit insert and child-link changes. The mutation rechecks current active account, module enablement, grant/Admin status, revision and relevant category/team/link state. A concurrent revoke or archive cannot sneak through between initial validation and commit. Child changes require the new audit identity, so a failed conditional update cannot replace another editor's links. Audit failure rolls the whole mutation back; audit metadata contains only revision/archive state, not descriptive content.

Migration `0032_hours_catalogs.sql` adds all five tables even when the module is disabled. Existing installations receive the three initial categories; fresh first-Admin setup inserts them in its installation transaction. There is no install trigger to duplicate or overwrite category seeds during restore.

Full installation backups use schema 17 and include all five tables. Validation checks identities, category/mode/team relations, canonical grouping, flags, bounded fields, planning snapshots and link limits before destructive restore. Existing backup versions 1–16 remain accepted; because they predate these tables they restore three default categories and empty activity/team catalogs. Schema 17 restores exact edited/archived category state without reseeding. Full installation restore intentionally replaces all installation module data; attendance/meeting-only operations preserve it. Composite deferred references keep historical relationships intact while permitting transactional full installation replacement.

## Verification and remaining work

`tests/hours-catalogs-d1.test.mjs` imports the actual Worker and uses local Miniflare D1. It exercises populated migration, CRUD, explicit roles/grants, stale edits, write-time grant/account/module revocation, concurrent category/team archive, atomic audit failure, grouping, safe snapshots, attendance deletion/restore, module disable/re-enable, malformed backups, full/legacy restore, empty optional fields, archive/reopen and fresh setup seeds. Existing Google/staff/module backup fixtures and the provisioning schema guard are advanced to schema 17.

Candidate verification passed: `npm run verify:api` (46 JavaScript tests, 130 TypeScript tests, API/shared typechecks), `npm run verify:migrations` (32 ordered migrations on fresh local D1), and `npm run verify:provisioning` (73 tests plus the template guard). This is local runtime verification, not development-deployment acceptance. No provider calls, external resources, migrations on hosted D1, UI, public submissions, hour entries, accounting, imports, publication controls or documentation editing are implemented by this unit. Future entry/UI/documentation units must enforce their own permissions and privacy allowlists while using these activity IDs.

## Staff planning selectors (WU-100 prerequisite)

These read-only routes share the current `hours.manage`/enabled-module checks of
the catalogs. They do not expand access to `/admin/users`, `/meetings`, roster or
attendance details. Both reject unsupported methods and unknown/repeated query
keys, default to 50 items and cap `limit` at 100. `after` is the prior `nextCursor`,
at most 128 characters; pages use ascending opaque ID order, not date order.
They are live views and perform no provider calls or writes.

- `GET /admin/hours/responsible-staff?limit&after&activityId` returns
  `{items:[{id,label,active,selectable,linked}],nextCursor}`. All active account
  roles are eligible, consistent with existing activity validation. A linked
  member name supplies the label, otherwise a valid local username. No email,
  credentials, role/grant record, roster identifier or contact field is returned.
  An optional installation-owned `activityId` also includes already-linked inactive
  accounts; it never opens the general inactive directory. Missing/foreign activity
  context returns 404. Existing selected identities can be retained even when
  `selectable` is false; that flag controls new selection only.
- `GET /admin/hours/attendance-sources?limit&after&from&to` returns
  `{items:[{id,title,serviceDate,startsAt,endsAt}],nextCursor,timeZone}`. Only
  non-test, non-deleted meetings from the installation appear. `from` and `to`
  are optional canonical UTC timestamps (`YYYY-MM-DDTHH:mm:ss[.SSS]Z`): from is
  inclusive and to is exclusive against the meeting start. Invalid/reversed
  bounds fail validation. The UI must derive date-range boundaries in the returned
  organization time zone, never implicitly in the browser zone. `serviceDate`
  is that zone's date of the meeting start. A multi-day source remains visible;
  existing creation validation still requires explicit per-day planning timing.

The current account schema has no dedicated display name. An unlinked Google-only
account therefore receives a generic missing-identity label with `active:true`
when active and `selectable:false`, not a fabricated inactive status. A previously
linked unnamed account receives an explicit historical label and is preserved.
An Admin can add a roster link or local username in Access settings before staff
select the account by name. This is a no-schema technical UI limitation; activity
mutation continues accepting legitimate active user IDs under its existing rules.

Selector regression coverage runs in `tests/hours-catalogs-d1.test.mjs` against
local D1 with synthetic data: capability/account/module checks, page bounds,
allowed historical identities, safe source fields, date filtering and isolation.
These tests are local evidence, not hosted development acceptance.

Catalog planning validation and selector service dates use the shared WU-101
`instantToCivil` helper, including Gregorian era handling and padded years
0000–0099. Local D1 fixtures cover source selection and linked activity creation
in those years; this does not change the saved-zone or single-day policies.
`npm run verify:api` passed for this prerequisite with WU-101: 54 JavaScript tests, 130 TypeScript tests, and API/shared typechecks. No schema or hosted-resource changes were required.

### Activity creation planning-zone precondition

Activity POST accepts `expectedTimeZone` as an optional creation precondition. A supplied value must be the current valid organization zone; a mismatch returns 409 and requires explicit reload. The staff editor always sends the zone used to resolve its draft clocks. Every activity creation also compares the zone read during request preparation against organization settings inside the atomic insert predicate, including requests that omit the optional precondition. A concurrent configuration change cannot persist a differently interpreted activity. PATCH rejects this field and retains the saved activity zone. No schema change is needed.
