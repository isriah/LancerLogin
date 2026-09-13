# Private Discord Hours submissions

Dependencies: WU-098 shared Discord, WU-099/101/102 catalogs, civil time and accounting,
WU-105 correction requests, and WU-115 schema 36. Migration 0037 adds only transient
interaction drafts. This work does not implement per-event calendar publication.

Enable and verify the shared Discord connection and Hour Tracking, then use
**Settings → Integrations → Reconcile Discord commands**. Reconciliation contributes
the guild-scoped `/hours` and `/hours-correction` commands alongside `/pair` and
`/attendance-report`. It updates only known command names and preserves unrelated
commands. Disabling Hours stops all draft admission and submission, including old
buttons; it does not delete commands, provider credentials, pairings or history.
Re-enabling does not require new credentials. A stale command can remain visible in
Discord while its module is off and returns an unavailable response.

Members must pair their Discord identity before starting. `/hours` privately walks
through the current category, service date and applicable event or supported team.
Each select is bounded to 25 choices with next/first-page navigation. Task categories
collect private notes. The member supplies start/end clocks and an explicit next-day
answer. Skipped daylight-saving clocks are rejected; repeated clocks require an
explicit earlier/later UTC offset before confirmation. The domain service rechecks
the current catalog, reporting/reopening window, installation time zone, pairing,
overlap, module and provider generation when committing. Hours count immediately.

`/hours-correction` accepts a private description and optional date/receipt reference.
It calls the same correction-request intake used by the public form. A request is
not a direct edit: Staff must review and record a resolution. Neither path returns
another entry's private details or exposes a member roster.

## Interaction and retry contract

The Worker validates Discord's Ed25519 signature over the exact bounded request
bytes before dispatch. Hours interactions additionally require the saved application,
configured guild and signed guild-member identity. Direct messages, another user’s
draft, another provider credential generation and unsigned requests are rejected.
Modal submissions are accepted only as type 5 details; selections and confirmation
are type 3 component interactions. Custom IDs carry only an opaque draft UUID,
revision and action, never member details, notes, receipts or credentials.

Read-only request admission has an absolute deadline below Discord's three-second
response limit. Normal operations immediately defer an ephemeral response, then use
the interaction webhook to edit only that private response. Opening a modal stays
within the deadline using read-only work. The webhook transport never attaches a bot
authorization header, follows redirects or records interaction tokens. Replies disable
all implicit mentions. Provider errors use fixed safe text, without reflecting URLs,
tokens or response bodies.

Draft payloads use authenticated encryption bound to installation, draft, guild,
member and provider IV. A draft expires after 20 minutes; there are at most four live
drafts per member and 256 per installation. Expired rows are removed on subsequent
Hours interaction, and portable backup excludes this transient table. Installation
restore deletes drafts through the existing installation foreign-key cascade.

The first confirmation atomically freezes its interaction ID as the idempotency key
and the exact submitted payload. Concurrent or repeated confirmations always retry
that frozen value. A successful original receipt/acknowledgement is replayed before
looking up the current member pairing, so a later unlink does not turn a confirmed
write into an uncertain failure. Module/provider fences still apply. Provider
rotation invalidates old drafts. Domain writes include the current verified provider
IV in their SQL predicate, preventing a disable/rotation race from committing.

If delivery of the private result fails, the original review button can recover the
result within the draft lifetime. An uncertain frozen submission cannot be edited
into a new payload. After expiration the member should ask Staff to check the receipt
or use a correction request rather than submitting a possible duplicate. Interaction
tokens are used only for the current reply, with a deadline shorter than their
15-minute provider lifetime; they are never persisted for background delivery.

## Verification boundary

`node --test tests/hour-discord-d1.test.mjs` uses real local Miniflare D1 migrations
and transactions, synthetic members, generated signing keys and mocked Discord HTTP.
It covers signed dispatch, protocol confusion, actor/provider/module fences, atomic
disable/rotation races, frozen concurrent confirmations, replay after unlink,
pagination/stale revisions, expiration/caps, DST/overnight clocks, command preservation,
bounded request reads and private webhook transport. `npm run verify:api` includes
this suite; `npm run verify:migrations` checks fresh schema application.

These checks are not a live Discord acceptance claim. Development acceptance still
requires the explicitly approved test server: install/verify the bot, reconcile the
commands, submit synthetic hours and a correction, and inspect private responses and
the resulting Staff records. Do not use production members or messages for this proof.
