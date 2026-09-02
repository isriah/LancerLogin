---
name: lancerlogin-wu
description: "Create one proposed LancerLogin work unit from a short feature request, defect report, or documentation need. Use when the user explicitly invokes $lancerlogin-wu; do not use to implement or coordinate work."
---

# LancerLogin Work-Unit Intake

Turn the text following `$lancerlogin-wu` into one well-scoped entry in `docs/future_work.md`. This is planning intake only: do not modify product code, tests, deployment state, existing work-unit status, or release state.

Read `AGENTS.md` and `docs/future_work.md` first. Inspect only the relevant product documentation and code needed to make the proposed unit specific and to avoid duplicating or overlapping an existing unit.

- Give the new unit the next available `WU-<number>` ID and use the documented work-unit format.
- Preserve the user's outcome. State a small scope, clear exclusions where useful, sources, observable acceptance criteria, focused verification, and tentative release impact.
- Use `Status: ready` when the request supports safe implementation. If a material product, security, or irreversible decision is missing, use `Status: blocked` and state the precise decision needed; do not invent it.
- If the request substantially duplicates an existing unit, do not add a duplicate. Explain the match and propose the smallest update or follow-up instead.
- Add one unit unless the user explicitly asks for a larger initiative to be split into several independently deliverable units.

After reviewing the final diff, commit only `docs/future_work.md` with a concise message such as `Add WU-011 card layout fix`. Preserve unrelated working-tree changes. Do not reserve the unit, create implementation tasks, merge, release, deploy, invoke the private upgrade workflow, mutate cloud resources, or update the Pi. Report the created ID, its status, assumptions or blocker, and the commit SHA.
