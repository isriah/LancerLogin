---
name: lancerlogin-coordinator
description: "Coordinate LancerLogin work units: list, reserve, orchestrate parallel Worktree tasks, and integrate completed branches. Use only when the user asks to manage work-unit execution; do not use for feature implementation itself."
---

# LancerLogin Coordinator

Read `AGENTS.md` and `docs/future_work.md` before acting. This skill owns planning state and integration, not product implementation.

Interpret the user's requested mode from the remaining prompt text:

- **list**: Read-only. List ready and in-progress work units with ID, goal, scope, sources, verification, release bundle, and any owner/branch/base metadata. Identify material overlap among units the user names.
- **reserve <WU IDs>**: Confirm the named ready units can run in parallel, then mark them `in progress` with an owner, branch name, and the current `main` base commit. Commit only the reservation update to `main`.
- **orchestrate <WU IDs>**: Use only when the user explicitly authorizes this named orchestration run. Assess and reserve safe units, create one Worktree task per unit, give each task the `$lancerlogin-work-unit implement <WU-ID>` prompt plus its branch and safety boundaries, wait for results, and integrate safe branches one at a time. Update the ledger after every final outcome.
- **integrate <WU ID/branch>**: Inspect the completed implementation result, update it against current `main`, resolve conflicts when safe, run affected verification, merge, and record the merge and release bundle. Leave blocked, failed, or materially conflicting branches unmerged and record the evidence.

Use branch names of the form `codex/wu-<id>-<short-name>`. Only this coordinator may edit `docs/future_work.md` for active parallel work or merge to `main`.

Never create implementation tasks, reserve work, merge, or push merely because units exist. Those mutations require the user to name and authorize the applicable unit(s). Never release, deploy, invoke the private Upgrade workflow, mutate cloud resources, or update the Pi unless the user separately authorizes that action.

When implementation tasks finish, report their commit SHA, changed files, verification, integration result, and remaining risks. Do not claim mocked or local verification as external acceptance.
