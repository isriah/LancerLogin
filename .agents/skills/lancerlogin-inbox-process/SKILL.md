---
name: lancerlogin-inbox-process
description: "Triage the LancerLogin Inbox into proposed work units, then record the user-approved units in the ledger. Use when the user explicitly invokes $lancerlogin-inbox-process; do not implement work units."
---

# LancerLogin Inbox Process

Read `AGENTS.md` and `docs/future_work.md`. Locate the Codex task titled `LancerLogin Inbox` and read its recorded ideas. If it is unavailable or ambiguous, ask the user to identify or provide the inbox; do not infer its contents.

## Triage

Do not modify product code, documentation, `docs/future_work.md`, branches, task reservations, releases, deployment state, cloud resources, or the Pi during triage.

- Deduplicate and group only items that share a coherent user-visible outcome, surface, acceptance criteria, and focused verification.
- Identify ideas already covered by an existing work unit and propose the smallest amendment or follow-up instead of a duplicate.
- Split ideas that span independent surfaces, dependencies, or verification into separately selectable candidates.
- Read only the project documentation and code needed to make each candidate concrete.
- For each candidate, provide a short outcome, scope and non-goals, relevant sources, observable acceptance criteria, focused verification, dependencies or overlap, and likely release bundle. Use candidate labels, not official WU IDs.
- For material grouping, product, scope, or release-bundle choices, use the structured Plan-mode decision framework in `AGENTS.md` when available.

Finish with a promotion-ready proposal and wait for the user's feedback or explicit approval. Do not invoke `$lancerlogin-wu-create`.

## Record approved units

When the user explicitly approves selected candidates in the same task, incorporate their feedback and automatically record those approved candidates as work units. Do this only in the coordinator task at a safe checkpoint, where it owns the shared ledger; otherwise direct the user to continue this task there.

- Re-read `docs/future_work.md` immediately before editing, assign the next available WU IDs, and use its documented format.
- Set `Status: ready` only when the candidate is safe to implement; otherwise use `Status: blocked` and state the exact missing decision.
- Add only the approved units. Do not reserve, create implementation tasks, merge, release, deploy, mutate cloud resources, or update the Pi.
- Review the diff, preserve unrelated changes, and commit only `docs/future_work.md` with a concise inbox-promotion message.
- Report the created WU IDs, status, assumptions or blockers, and commit SHA. Do not ask for a redundant promotion confirmation after the user's approval.
