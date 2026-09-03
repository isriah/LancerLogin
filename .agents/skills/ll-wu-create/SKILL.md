---
name: ll-wu-create
description: "Create one proposed LancerLogin work unit from a short feature request, defect report, or documentation need. Use when the user explicitly invokes $ll-wu-create; do not use to implement or coordinate work."
---

# LancerLogin Work-Unit Creation

Turn the text following `$ll-wu-create` into one well-scoped entry in `docs/future_work.md`. This is planning only: do not modify product code, tests, deployment state, existing work-unit status, or release state.

Read `AGENTS.md`, `docs/WORKFLOW.md`, and `docs/future_work.md`. Inspect only the documentation and code needed to make the proposed outcome concrete and prevent duplicate work.

- Give the new entry the next available `WU-<number>` ID and use the ledger format.
- Preserve the requested outcome. Define small scope, useful exclusions, sources, observable acceptance criteria, focused verification, and tentative release impact.
- Use `ready` when implementation is safe. If a material product, security, architecture, or irreversible decision is missing, use `blocked` and state the one missing decision; do not invent it.
- If it duplicates an existing WU, do not add a duplicate. Explain the match and propose the smallest amendment or follow-up.
- Add one WU unless the user explicitly asks to split a larger initiative.

Review the diff and commit only `docs/future_work.md`. Preserve unrelated changes, including uncommitted inbox entries. Do not reserve work, create implementation tasks, merge, release, deploy, mutate cloud resources, or update the Pi. Report the WU ID, status, assumptions or blocker, and commit SHA.
