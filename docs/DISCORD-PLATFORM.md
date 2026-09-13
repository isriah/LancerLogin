# Shared Discord platform service (WU-098)

Dependencies: shared platform/provider baseline, the existing single encrypted Discord integration, scheduler admission budgets and the implemented attendance interaction handlers. This unit changes no provider destination, schema, UI, token or deployment.

`apps/api/src/discord-platform.ts` owns server-only credential/verification loading, Discord HTTP transport, interaction signature verification, bounded raw-body reads and managed command composition. Attendance handlers, private response construction, pairing/contest verification, calendar operation leases and message ownership remain consumers in the API. The shared `HttpError` extraction is mechanical and preserves HTTP classification. No browser endpoint returns credentials or acts as an arbitrary provider proxy.

Credential loading reads the same installation-scoped encrypted record and enabled flag, retaining separate enabled/verified gates for operational work and the signed verification callback. Unverified configuration is usable only by the existing server verification path. The scheduler admission symbol remains attached to the decrypted server-only configuration, so every retry consumes the same per-pass request budget. D1 access still passes through the existing wrapped database. The 32-statement/12-provider admission ceilings remain unchanged.

## Managed command reconciliation

The registry accepts implemented attendance (`/pair`, `/attendance-report`), Hours (`/hours`, `/hours-correction`) and Documentation (`/activity-note`) owners, plus the separately gated development attachment proof. Composition rejects missing core commands, duplicate names, wrong types, unsupported owners and unimplemented contributions. Each module contributes only its implemented handlers and exact reviewed definitions.

Reconciliation verifies the bot application, selected guild and attendance text channel before changing commands. It reads the guild command inventory, creates a missing managed command using individual POST, or repairs a drifted managed command using PATCH to its validated ID. Matching commands require no writes. It never sends collection PUT, command DELETE or global-command mutations. Same-name commands of other types remain unrelated.

A final GET must confirm the managed definitions and unchanged unrelated command objects before reporting success or recording the existing verification/audit outcome. Wrong application/guild, malformed command or option shapes, invalid IDs and duplicate IDs/name-type identities fail closed. Provider-added harmless option metadata is tolerated; additional option behavior is not mistaken for a matching managed definition. Explicit empty options clear drift on the no-option report command.

Two provider command mutations cannot form an atomic transaction. A partial failure may leave one managed command repaired. A later explicit reconciliation reads current state and repairs remaining drift; it does not restore or rewrite unrelated commands. Concurrent administrators/external command edits can cause readback failure; there is no provider transaction or distributed command lock. No command permissions or unrelated command definitions are intentionally changed.

## Engineering bounds and security

The following are proposed implementation bounds exercised with local tests, not measured deployment capacity or official Discord payload limits:

- Interaction body: 65,536 UTF-8 bytes, read from the stream before JSON parsing; oversized bodies fail with 413. Invalid UTF-8 is rejected. Public key/signature lengths are checked and Ed25519 verifies timestamp plus the raw decoded body. The existing five-minute timestamp window remains; this is freshness validation, not a new replay ledger.
- Provider response: 1,048,576 bytes per response. Malformed JSON fails closed. Provider-supplied error messages are replaced with fixed text; status/code classification still supports owned-message recovery and actionable permission/token/rate-limit errors.
- Transport: fixed Discord HTTPS v10 origin, restricted relative path families, no redirects, ten-second attempt deadline, at most three attempts on 429 and no in-request wait over five seconds. Each attempted fetch charges an attached scheduler budget before dispatch. Caller signals cannot remove the deadline; headers cannot replace the bot authorization.
- Command inventory: at most 110 guild commands and 25 options per command. Reconciliation uses five read operations and at most one mutation per managed command before retries. With all six implemented commands enabled, the conservative three-attempt bound is33 HTTP attempts outside a stricter scheduler budget. The separate existing verification challenge flow adds its own bot/message operations.

The signature/initial private interaction response path gains no new outbound transport calls or retry delay. Discord's acknowledgement deadline remains applicable; unchanged domain database work still requires hosted latency acceptance. Provider transport retry policy is inherited, with a missing Retry-After now using the existing one-second fallback rather than interpreting a missing header as zero.

## Verification

Run `npm run verify:api`. New production-import tests in `tests-ts/integration-runtime.test.ts` cover composition boundaries, owned drift repair, unrelated preservation, idempotent reads, malformed/duplicate/foreign inventories, uncertain readback, bounded retries/payloads, safe errors, scheduler budget admission, signed body/timestamp failures and encrypted credential loading. Existing actual Worker tests were adapted to model individual command creation and authoritative readback, retaining signed verification, pairing, report, contest, Calendar lease/retry and permission assertions. Existing local workerd/SQLite scheduler tests exercise the extracted transport through attendance delivery.

All results use synthetic local data and mocked provider responses. No live command registration, bot verification, deployed CPU/latency, or provider delivery is established by these checks. Supported development Discord acceptance remains necessary before deployment acceptance.

Primary provider references: [application command endpoints and name/type upsert semantics](https://docs.discord.com/developers/interactions/application-commands), [signed interactions and response timing](https://docs.discord.com/developers/interactions/receiving-and-responding), and [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits).

## Development attachment transfer

At the exact approved development origin, command composition also includes the implemented `/attachment-proof` synthetic File Upload modal. Core/Hours commands and unrelated provider commands remain preserved. It is unavailable elsewhere and creates no general Documentation capability. See [DISCORD-ATTACHMENT-FEASIBILITY.md](DISCORD-ATTACHMENT-FEASIBILITY.md) for fixture, privacy, timeout and recovery limits.
