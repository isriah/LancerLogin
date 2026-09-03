---
name: lancerlogin-inbox-process
description: "Triage the LancerLogin Inbox into proposed, deduplicated work units without changing the repository. Use when the user explicitly invokes $lancerlogin-inbox-process; do not use to create or implement work units."
---

# LancerLogin Inbox Process

Read `AGENTS.md` and `docs/future_work.md`. Locate the Codex task titled `LancerLogin Inbox` and read its recorded ideas. If it is unavailable or ambiguous, ask the user to identify or provide the inbox; do not infer its contents.

Triage only. Do not modify product code, documentation, `docs/future_work.md`, branches, task reservations, releases, deployment state, cloud resources, or the Pi.

- Deduplicate and group only items that share a coherent user-visible outcome, surface, acceptance criteria, and focused verification.
- Identify ideas already covered by an existing work unit and propose the smallest amendment or follow-up instead of a duplicate.
- Split ideas that span independent surfaces, dependencies, or verification into separately selectable candidates.
- Read only the project documentation and code needed to make each candidate concrete.
- For each candidate, provide a short outcome, scope and non-goals, relevant sources, observable acceptance criteria, focused verification, dependencies or overlap, and likely release bundle. Use candidate labels, not official WU IDs.
- For material grouping, product, scope, or release-bundle choices, use the structured Plan-mode decision framework in `AGENTS.md` when available.

Finish with a promotion-ready proposal. Do not invoke `$lancerlogin-wu-create`; creation happens only after the user explicitly approves candidates in a safe coordinator checkpoint.
