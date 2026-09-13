# Private Documentation initiatives

Dependencies: WU145 Documentation authority and section contracts, current Hours activities/accounting, and both enabled modules. This is the private narrative/grouping backend subset of P4. It calls no provider and does not complete initiative evidence, artifacts, claims, metrics, packets or member intake.

An initiative has a stable installation-scoped ID, title, plain-text narrative, archived flag, optimistic revision and immutable creator/creation time. It may start empty. Every successful create/edit/archive/unarchive stores the full narrative and membership snapshot with acting staff and timestamp. Audit metadata excludes narrative and title text. There is no hard-delete route and no arbitrary member contribution route. Hours activities remain independently usable and their totals, identity and attendance links are unchanged.

All routes require current `documentation.manage` or active Admin, with both modules enabled. Activity-notes section enablement does not control initiatives. The existing participant/hour summary section controls computed summaries independently. Disable/re-enable preserves records. Inactive creators remain valid history references.

## API contract

The prefix is `/admin/documentation/initiatives`. Responses use the existing signed-session, JSON/CORS and safe error boundary.

- GET the prefix: `{initiatives,next}`; `after` is an opaque ID, `limit` is 1-50 (default25), `archival=true` includes archived initiatives. Otherwise only active initiatives are listed.
- POST the prefix: `{title,narrative?,activities?}`; activities default empty. Each link is `{activityId,revision}`. Returns201 `{initiative}`.
- GET `/:id`: `{initiative,activities,readOnly,linkedActivityCount,eligibleActivityCount,omittedActivityCount,summary?}`. Activities contain only activityId, title, revision, archived and impactRelevant; no Hours description, roster or individual entries.
- PATCH `/:id`: `{revision,title?,narrative?,activities?,archived?}`. Activities is an explicit complete replacement; omission preserves membership. Returns200 `{initiative}`. An archived initiative accepts only `{revision,archived:false}`; reload before a separate edit.
- GET `/:id/history`: `{initiativeId,authorUserId,createdAt,revisions,next}`. History uses integer after-revision pagination and the same limits. Each revision contains revision, actorUserId, title, narrative, archived, createdAt, activityIds and activities:[{activityId,title}]. Membership is historical, not recomputed from current links. The additive activities field resolves current activity titles through the installation-scoped revision links, including removed or relevance-lost links. These titles are not historical title snapshots; clients label them as current titles. No unrelated activity lookup or Hours description is exposed. `next:null` indicates the final page.
- POST `/summary`: `{initiativeIds}` with1-100 unique IDs. Returns the same three activity counts and optional summary. Unknown/unavailable IDs reject the entire request; they are never silently omitted.

An initiative DTO is `{id,title,narrative,archived,revision,authorUserId,createdAt,updatedAt}`. Technical defaults: title1-200 and narrative0-8000 UTF-16 code units, plain text with control characters rejected; max100 distinct activities per initiative; max60000 UTF-8 bytes per JSON request. Clients render text as text, not HTML. These limits are implementation defaults, not a new product constraint.

Adding an association requires an existing active impact-relevant activity at its supplied current revision. A retained association can survive activity archival/relevance loss and may be removed with the current initiative revision. Its prior membership stays in history. Revision, active user/grant/modules and eligibility of newly added activities are checked in the mutation statement. The request's uniquely admitted audit row gates all remaining statements in the transaction. Stale or unauthorized contenders cannot replace links or append history.

Summary selection uses the union of distinct eligible activity IDs across active selected initiatives and counts each counted entry once, with unique participants over that union. It never adds per-initiative participant counts. Archived initiatives and archived/nonimpact linked activities do not contribute; omittedActivityCount makes exclusions explicit. An activity linked through both archived and active selected initiatives counts once when eligible through the active one. The summary flag, current authority, initiative availability and aggregate share one SQL snapshot. Disabled summaries are omitted, not zero; enabled empty summaries are zero. Detail metadata and aggregate likewise share one statement.

Invalid input returns400; inactive/absent sessions401; missing module/grant403; unavailable records404; stale revisions, invalid additions or authority lost at mutation409; unsupported methods405. Reload and review after409; do not automatically retry writes.

## Backup and verification boundary

Migration0041 adds initiative headers, current links, immutable revision headers and revision links with installation-scoped foreign keys. Portable backup22 includes all four tables; versions1-21 normalize empty initiative tables. Validation rejects duplicate/missing revisions, cross-scope/missing activity or actor references, inconsistent current/latest membership, altered creator provenance and edits to an archived revision other than a pure unarchive. Validation occurs before destructive restore. Attendance-only restore preserves initiatives/history.

The local raw recovery fixture includes all four tables and now pins41 migrations/64 tables. This is local evidence, not an upgrade to previous hosted recovery evidence. Portable application backups still exclude transient provider authority; raw D1 export and the existing guarded external-effect inventory procedure remain separate. Database restoration does not copy or reverse Drive files. There are no artifact/evidence file relationships in this work unit.

Focused checks: `node --test tests/documentation-initiatives-d1.test.mjs tests/application-recovery-spike.test.mjs tests/foundation.test.mjs`, `npm run verify:api`, and `npm run verify:migrations`. All fixtures are synthetic and local. Hosted acceptance requires a coordinator-reviewed schema41/API deployment; this unit does not perform it.

## Staff dashboard (WU-148)

Activity Documentation includes Activities and Initiatives views under one page
heading. Documentation-only Staff and Admins can create empty initiatives, edit
plain-text titles/narratives, select up to 100 eligible activities across cursor
pages, remove retained archival associations, archive and explicitly unarchive,
and inspect paginated immutable narrative/membership history. Historical membership
uses the additive history response's current activity titles, labeled accordingly;
these are not historical name snapshots. No raw staff/member identities are shown.

The combined summary uses the server's union endpoint for selected initiatives
across pages, with linked/eligible/omitted counts and unique participants. Summary
disable is displayed as disabled, never zero. Notes disable does not block
initiatives. Revocation hides and clears private state; obsolete read generations
cannot restore it. A separate mutation guard survives focus refresh. Uncertain
writes require explicit reload and review of saved state alongside preserved drafts;
no write is automatically retried. New draft associations that become unavailable
must be removed before save, while saved historical associations remain removable.

Verification: `npm run verify:dashboard`, existing
`documentation-workspace.spec.ts`, and `initiatives-workspace.spec.ts`. Synthetic
browser coverage includes role denial, CRUD/history, union/omission/disabled
summaries, cursor paging, UTF-16 limits, relevance loss, stale/uncertain requests,
delayed access races, keyboard focus and custom-brand light/dark desktop/mobile
screenshots. Shared typography, spacing, semantic colors, radii and 44px controls
are reused without UI-standard exceptions. Hosted acceptance requires combined
backend/dashboard deployment including the named historical membership response.
Artifacts, files, claims, metrics, member intake and packets remain subsequent work.
