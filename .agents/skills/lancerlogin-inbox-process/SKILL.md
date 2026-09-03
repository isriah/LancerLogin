---
name: lancerlogin-inbox-process
description: "Triage the durable LancerLogin idea inbox into proposed work units, then record user-approved units in the ledger. Use when the user explicitly invokes $lancerlogin-inbox-process; do not implement work units."
---

# LancerLogin Inbox Process

Read `AGENTS.md`, `docs/WORKFLOW.md`, `docs/idea_inbox.md`, and `docs/future_work.md`. `docs/idea_inbox.md` is the authoritative raw-intake source, including expected uncommitted local entries; do not use task history as a substitute for it.

## Triage

Do not modify product code, branches, task reservations, releases, deployment state, cloud resources, or the Pi during triage. Do not alter `docs/idea_inbox.md` or `docs/future_work.md` until the user approves candidates for promotion.

- Consider only entries with `Status: untriaged`. If none exist, report that the durable inbox is empty; do not inspect task history to look for ideas and do not claim that unread task messages are complete.
- Deduplicate and group only items that share a coherent user-visible outcome, surface, acceptance criteria, and focused verification.
- Identify ideas already covered by an existing work unit and propose the smallest amendment or follow-up instead of a duplicate.
- Split ideas that span independent surfaces, dependencies, or verification into separately selectable candidates.
- Read only the project documentation and code needed to make each candidate concrete.
- For each candidate, provide a short outcome, scope and non-goals, relevant sources, observable acceptance criteria, focused verification, dependencies or overlap, and likely release bundle. Use candidate labels, not official WU IDs.
- For material grouping, product, scope, or release-bundle choices, use the structured Plan-mode decision framework in `AGENTS.md` when available.

Finish with a promotion-ready proposal that identifies the included `IN-###` entries and wait for the user's feedback or explicit approval. Do not invoke `$lancerlogin-wu-create`.

## Record approved units

When the user explicitly approves selected candidates in the same task, incorporate their feedback and automatically record those approved candidates as work units.

- Re-read `docs/idea_inbox.md` and `docs/future_work.md` immediately before editing. Do not promote while another task is changing the ledger; report that conflict and ask the user to retry after it is resolved. Assign the next available WU IDs, use the documented work-unit format, and promote only the proposal's named `IN-###` entries.
- Set `Status: ready` only when the candidate is safe to implement; otherwise use `Status: blocked` and state the exact missing decision.
- Add only the approved units. Change each source inbox entry to `promoted` and record its WU ID(s); use `covered` or `discarded` only when the user approves that disposition and state why. Do not reserve, create implementation tasks, merge, release, deploy, mutate cloud resources, or update the Pi.
- Review the diff, preserve unrelated changes, and commit only `docs/idea_inbox.md` and `docs/future_work.md` with a concise inbox-promotion message.
- Report the created WU IDs, status, assumptions or blockers, and commit SHA. Do not ask for a redundant promotion confirmation after the user's approval.
