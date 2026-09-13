# Private Documentation foundation

Dependencies: enabled Hour Tracking and Activity Documentation modules, current Documentation management grant (or active Admin), and existing Hours activity/accounting contracts. This backend subset does not close provider feasibility gates or complete P4. No provider is called and no note is published.

`/admin/documentation/sections` GET returns the typed version-1 registry (`notes`, `participant-hours`) and revisioned flags. Admin PUT requires version, revision, notesEnabled and summaryEnabled. Both sections default enabled. Disabling sections or modules preserves records; module disable makes these routes unavailable.

`/activities` GET provides cursor pagination (after, limit 1-50, default 25). Default selection is active impact-relevant activities. `archival=true` additionally includes activities with preserved notes, never unrelated Hours-only activities. `/activities/:id` returns narrow activity metadata and, while enabled, counted minutes and distinct participants without member identities, individual entries or private Hours descriptions. Visibility, flags and summary share a SQL read snapshot.

`/activities/:id/notes` GET paginates notes; POST requires activityRevision, sectionRevision and text. `/notes/:id` GET returns the note; PATCH requires revision, activityRevision, sectionRevision and text and/or archived. Notes attached to archived or nonimpact activities are read-only. Mutations atomically recheck active authority, both modules, the notes section revision and activity eligibility/revision. Conflicts return 409 without mutation or audit. Author and creation time are immutable; every successful mutation appends a complete revision and an audit excluding note text. Text is plain text, nonblank, at most 8000 UTF-16 code units; JSON requests are bounded to 40000 UTF-8 bytes. Control characters other than whitespace are rejected.

`/notes/:id/history` uses integer after-revision pagination, preserves original author/creation provenance and returns each revision actor and timestamp. Inactive authors remain valid historical references. Clients must render text as text, never HTML.

Installation backup format 21 includes the three Documentation tables. Validation rejects missing or duplicate revision links, invalid provenance, unknown users/activities and cross-installation references before destructive restore. Older formats initialize empty records and default sections. Attendance-only restore preserves all Documentation records. Migration 0040 extends the local raw recovery graph to 40 migrations; this is local evidence and does not upgrade earlier hosted schema-39/38 recovery evidence. Transient attachment proof receipts remain outside portable backup: inventory their operation/file identities privately before future destructive recovery, and resolve pending provider effects under their existing guard. SQL restore does not reverse Drive operations.

This unit deliberately leaves UI, member intake, claims, metrics, initiatives, artifacts, packets and general attachment validation to subsequent required P4 units. The limits and endpoint shapes here are technical defaults within confirmed product decisions.

## Response and error contract

Activity list: `{activities:[{id,title,mode,serviceDate,teamId,revision,archived,impactRelevant}],next}`. Activity detail adds `readOnly`, `sectionRevision`, and optional `summary:{countedMinutes,distinctParticipants}`. Disabled summary is omitted, never represented as zero. Notes list: `{notes,next,readOnly,sectionRevision,activityRevision}`. A note is `{id,activityId,authorUserId,text,archived,revision,createdAt,updatedAt}`; create/edit and direct read wrap it as `{note}`. History: `{noteId,authorUserId,createdAt,revisions:[{revision,actorUserId,text,archived,createdAt}],next}`. Activity/note cursors are opaque IDs; history cursors are revision integers. `next:null` means the final page. Clients preserve current activity, section and note revisions when submitting mutations and reload on conflict.

Invalid input returns 400; absent/inactive sessions return 401 through the existing session boundary; absent module/grant authority returns 403; unavailable records return 404; stale revisions or authority lost at the atomic mutation boundary return 409. Unsupported route methods return 405. A non-Admin configuration write cannot mutate settings and returns the same 409 configuration/authority conflict. Errors do not contain note contents. These are private Staff/Admin endpoints; being paired in Discord or having an Hours-only grant does not grant access.

## Staff workspace (WU-146)

`/documentation` provides private staff note curation, independent of Google
availability and the Hours management grant. The shell uses current effective
Documentation capability and both module gates; Documentation-only Staff have a
workspace landing link without attendance navigation. Eligible activity selection
is paginated, with explicit archival inclusion for preserved notes. Current
participant/hour aggregates never show roster identities; disabled summaries are
omitted rather than displayed as zero. Disabled notes and archived/nonimpact
activities preserve readable notes/history while blocking writes.

Admin-only version-1 built-in section controls use the current section revision.
Note writes include section, activity and note revisions as applicable and perform
server readback. Conflicts or uncertain results lock writes until explicit reload
and review; drafts are preserved, with no automatic mutation retry. Access checks
hide private content while loading and clear it on revocation. Async reads are
fenced against obsolete access generations, including React StrictMode remounts.

Focused verification: `npm run verify:dashboard` and
`npm run test:browser -- documentation-workspace.spec.ts`. The synthetic browser
suite covers staff/Admin writes, denial/revocation, delayed reads, immutable plain
text history, cursor paging, disabled versus zero summaries, archival gates,
UTF-16 limits, reload recovery, keyboard and custom-brand light/dark screenshots
at 1280x900 and 390x844. The surface reuses the shell, Hours forms/cards and shared
UI tokens; no UI-standard exceptions are introduced. Hosted acceptance requires
schema 40 and a combined dashboard/API deployment by the maintainer. These local
checks do not establish hosted acceptance. Files, claims, metrics, initiatives,
member intake and packets remain required subsequent work.

Member intake now extends these same note records with nullable staff IDs, real member provenance, revision-bound review and portable schema26. See [the current additive contract](MEMBER-DOCUMENTATION.md); original staff field values remain unchanged.
