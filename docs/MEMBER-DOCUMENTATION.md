# Member Documentation notes

Dependencies: existing Hours activity identities, both modules enabled, versioned notes section, roster identities, WU145 notes and current Documentation staff authority. This backend unit adds real member submissions to the existing notes domain. The public form and staff provenance/review controls consume this contract. Discord note command wiring is described in [DISCORD-DOCUMENTATION.md](DISCORD-DOCUMENTATION.md); file intake remains required later. The shared note service calls no provider.

## Intake and identity

GET `/public/documentation/context` returns `{available,sectionRevision?}`. GET `/public/documentation/activities?after=<id>&limit=25` returns `{activities:[{id,title,serviceDate,mode,revision}],next,sectionRevision}` with 1-50 items. Only active impact-relevant activities are eligible; there is no Hours reporting-window restriction. Catalogs reveal no notes, roster records, private Hours descriptions or participant summaries. Module/notes-section disable makes intake unavailable.

POST `/public/documentation/notes` requires `{memberId,activityId,activityRevision,sectionRevision,text,idempotencyKey}`. `memberId` is the exact external roster identifier as text, preserving leading zeros. A matching active roster record is self-asserted identity, not authentication or verified content. Unknown, inactive, cross-installation and stale submissions use a generic conflict response. No source/attribution/actor flags are accepted from JSON. Text shares the staff limit: nonblank plain text, at most 8000 UTF-16 code units, no controls except whitespace. JSON is bounded to 40000 UTF-8 bytes and a ten-second read deadline. These are technical defaults.

A successful POST returns HTTP202 `{accepted:true,reference}` only. The random reference is a transport acknowledgement, not a public retrieval capability or staff review. There are no public note/history/roster routes. Keep the exact body and key frozen for an explicit retry. Keys are 16-128 characters, hashed at rest; a fingerprint binds the exact contribution and claimed identity. Note, initial immutable revision, text-free audit and acknowledgement are admitted atomically with current member/module/section/activity gates.

Exact receipt replay intentionally precedes current eligibility checks: it returns only the original opaque acknowledgement after member deactivation, activity archival or module disable, without a new write or any saved content. Different input with the same key conflicts. Replay is not approval of a new contribution under current settings.

The server-only service also supports paired Discord provenance. A later adapter must verify the actual signed interaction, application/guild/current connection and requester before invoking it. New Discord writes fence the active member pairing, enabled connection and captured encrypted-provider IV. Public JSON cannot choose Discord identity.

## Admission and Pages boundary

Documentation uses a separate purpose-bound signature/header/path, `/public/documentation/`, reusing only the existing provisioned Pages transport key material. Hours signatures and their 16384-byte limit are unchanged. Signatures bind method, complete serialized path/query, body digest, origins, installation and freshness. Supplied assertion headers are stripped at Pages. Unknown or untrusted source provenance shares a restrictive bucket; IP/header values from an arbitrary client never establish a distinct source.

Separate Documentation counters use the established bounded policy: mutations 30/source-minute, 300/source-hour, 300/installation-minute and 5000/installation-day; reads 120/source-minute, 1200/source-hour, 1200/installation-minute and 20000/installation-day. Matching the existing public-form policy avoids an unmeasured throughput increase; counters cannot consume Hours quotas. Failure to reserve admission fails closed; rate limits return Retry-After. Counters contain rotating HMAC subjects, not raw IPs or member IDs. No note text or claimed identifier enters audit metadata.

## Provenance and curation

Migration0045 rebuilds existing note/history tables with installation-scoped nullable user/member FKs and constrained source. Every author/actor is exactly one real staff user or member. Existing staff IDs/text/timestamps/revisions are copied unchanged. Member authors and original revision text remain immutable after staff edits. Referenced members must be deactivated rather than deleted.

Existing staff `authorUserId` and history `actorUserId` values remain unchanged. They are null for member provenance. Added `contributor` is `{kind,userId,memberId,source,attribution,currentMemberLabel}`; source is staff/public/discord, attribution is staff/self_asserted/linked_discord. A member label is a current name projected only from an authorized note/history reference, not a historical name snapshot or general roster lookup. Create responses may omit a current label (null); reload obtains it. Staff UI accepts nullable author/actor IDs and distinguishes submission attribution without displaying internal IDs.

POST `/admin/documentation/notes/:id/review` requires `{revision,activityRevision,sectionRevision,decision:'reviewed'|'rejected'}`. Only current Documentation staff/Admin can curate. Review advances the note revision and appends a complete immutable snapshot. `review` is null or `{decision,reviewedRevision,reviewerUserId,reviewedAt}` and pins the immediately preceding content revision. Concurrent reviewers cannot both accept the same revision. Normal edit/archive/unarchive clears current review; earlier review remains in history. Intake never requires staff review to be stored, and reviewing never publishes it. Notes on archived/nonimpact activities remain read-only. Disabled notes retain authorized reads and prohibit mutations.

## Recovery and verification boundary

Portable schema26 includes member provenance, review snapshots and note submission receipts. Versions1-25 normalize old notes to staff provenance and empty receipts. Validation checks actual user/member/activity references, complete revision chains, initial author equality, review revision/content/actor invariants, and one durable receipt per member note before destructive restore. Attendance-only restoration preserves these records. Transient public admission counters are excluded from portable backup; raw D1 recovery includes them.

The local recovery graph now covers45 migrations/91 tables, including a real member note/receipt. This is local/mock evidence, not hosted schema45 recovery or public-form/Discord acceptance. SQL restoration does not reverse provider effects; existing publication/attachment recovery guards remain applicable.


## Public form and staff workspace

`/submit-documentation` opens directly without dashboard sign-in. Staff can open it from the activity notes workspace and share that route. Activity choices show title/date, preserve an exact text member ID, and never request roster or note history. Notes are independent of Hours; the separate Hours link opens a new tab so the current note result is retained. Neither success nor failure changes an Hours outcome.

The form validates actual calendar dates in catalog DTOs and validates acknowledgements against the minimal response shape. It freezes the exact serialized request only after local size preflight passes. Unconfirmed requests require an explicit identical retry; no timer submits automatically. Discard warns before acting that a note may already exist and that acknowledgement recovery will be lost. Drafts, member IDs, notes and receipts are never stored in browser local/session storage. A refresh or close loses the in-page recovery state. Local over-size input stays editable without a network request, including JSON escape expansion of lone surrogate code units.

Staff notes use the shared existing domain, display source/current member name, support review/rejection of a saved revision, and retain original provenance through edits. Dirty drafts block review and unrelated note changes. Pure unarchive sends only archive state and concurrency fields. History validates its actual author/revision/contributor/review envelope and never substitutes a current author for a historical actor. Reviewer display is deliberately generic "Staff review" because the DTO provides no reviewer name or role. Current-grant loss clears private data; uncertain writes lock mutations and require explicit reload. Section/activity changes during write readback preserve drafts and prevent a misleading success confirmation.

UI implementation reuses the existing typography, semantic colors, card/spacing/control tokens and native controls, with no new CSS tokens or visual-standard exceptions. Local QA covers 1280x900 and390x844, light/dark, custom brand colors, keyboard focus and44px controls. The browser suites use synthetic data and mocked API responses; they do not establish hosted member acceptance or Discord/file intake. Required later work remains explicitly separate.
