---
name: lancerlogin-coordinator
description: "Coordinate LancerLogin work units: list, reserve, orchestrate parallel Worktree tasks, and integrate completed branches. Use only when the user asks to manage work-unit execution; do not use for feature implementation itself."
---

# LancerLogin Coordinator

Read `AGENTS.md` and `docs/future_work.md` before acting. This skill owns planning state and integration, not product implementation.

Interpret the user's requested mode from the remaining prompt text:

- **list**: Read-only. List ready and in-progress work units with ID, goal, scope, sources, verification, release bundle, and any owner/branch/base metadata. Identify material overlap among units the user names.
- **reserve <WU IDs>**: Confirm the named ready units can run in parallel, then mark them `in progress` with an owner, branch name, and the current `main` base commit. Commit only the reservation update to `main`.
- **orchestrate <WU IDs>**: Use only when the user explicitly authorizes this named orchestration run. Assess and reserve safe units, create one Worktree task per unit, give each task the `$lancerlogin-wu-develop develop <WU-ID>` prompt plus its branch and safety boundaries, wait for results, and integrate safe branches one at a time. Update the ledger after every final outcome.
- **integrate <WU ID/branch>**: Inspect the completed implementation result, update it against current `main`, resolve conflicts when safe, run affected verification, merge, and record the merge and release bundle. Leave blocked, failed, or materially conflicting branches unmerged and record the evidence.

Use branch names of the form `codex/wu-<id>-<short-name>`. Only this coordinator may edit `docs/future_work.md` for active parallel work or merge to `main`.

Before reserving or spawning tasks, classify the named units by both their declared scope and possible shared substrates. Treat a unit that may change a migration/schema, shared contract, authorization policy, deployment configuration, or shared documentation file as overlapping until source-level inspection establishes otherwise. In particular, “if needed” migration work is not safe to parallelize with another unit that changes migrations or the same schema. Run dependent units in later cohorts from the updated `main` base.

After creating implementation tasks, retain their task IDs and wait for completion or attention with the task waiting mechanism. Do not repeatedly poll task lists or worktree state unless a completion event, timeout, or a specific integration question requires inspection.

An explicit `orchestrate` authorization permits routine, in-scope integration repairs such as rebasing, resolving mechanical conflicts, and renumbering a not-yet-applied migration with its directly affected references and tests. Confirm that the migration has not been applied outside the branch and that its semantics do not change; otherwise leave the unit blocked for a user decision.

Execute dependent Git and verification steps as separate commands and check each result before proceeding. Do not use PowerShell semicolon chaining for a mutation followed by another mutation or verification.

Never create implementation tasks, reserve work, merge, or push merely because units exist. Those mutations require the user to name and authorize the applicable unit(s). Never release, deploy, invoke the private Upgrade workflow, mutate cloud resources, or update the Pi unless the user separately authorizes that action.

When implementation tasks finish, report their commit SHA, changed files, verification, integration result, and remaining risks. Do not claim mocked or local verification as external acceptance.

After the coordinator records the final merged, blocked, or failed outcome and has captured the task's commit/verification/risk evidence, archive the corresponding implementation task. Do not archive it while integration, a user decision, or another requested follow-up remains. Keep the coordinator and inbox tasks active; archived implementation tasks remain available for audit or restoration.
