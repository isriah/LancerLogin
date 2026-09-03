---
name: lancerlogin-coordinator
description: "Coordinate LancerLogin work units: list, reserve, orchestrate parallel Worktree tasks, and integrate completed branches. Use only when the user asks to manage work-unit execution; do not use for feature implementation itself."
---

# LancerLogin Coordinator

Read `AGENTS.md` and `docs/future_work.md` before acting. This skill owns planning state and integration, not product implementation.

Interpret the user's requested mode from the remaining prompt text. For `list`, `reserve`, and `orchestrate`, accept individual WU IDs, `all` (every currently `ready` unit), or an inclusive ID range such as `WU-011..WU-018`. Expand a selector from the current ledger immediately before acting; report units excluded because they are not ready, invalid, or outside the range. A range does not bypass overlap checks or allow re-running an active, merged, or blocked unit.

- **list [selector]**: Read-only. List the selected ready and in-progress work units with ID, goal, scope, sources, verification, release bundle, and any owner/branch/base metadata. Identify material overlap among selected units.
- **reserve <selector>**: Confirm the selected ready units can run in parallel, then mark them `in progress` with an owner, branch name, and the current `main` base commit. Commit only the reservation update to `main`.
- **orchestrate <selector>**: Use only when the user explicitly authorizes this selected orchestration run. Assess and reserve safe units, create one Worktree task per unit, give each task the `$lancerlogin-wu-develop develop <WU-ID>` prompt plus its branch and safety boundaries, wait for results, and integrate safe branches one at a time. Update the ledger after every final outcome.
- **complete-all**: The explicit invocation authorizes one orchestration run for every work unit that is `ready` when the run begins. Report existing in-progress or blocked units but never duplicate them. Use maximum safe parallelism, integrate serially, and continue until every selected unit is `merged`, `blocked`, or `failed`. This never authorizes a release, deployment, cloud-resource change, or Pi update.
- **resume [selector]**: Reconcile a previously authorized run before taking any new action. Inspect every recorded task ID, provisioning ID, branch, and candidate Worktree for the selected `in progress` units. Do not create a replacement, reserve another unit, or start a later cohort until each selected unit is confirmed active, has been restored to `ready` after a concrete provisioning failure, or is recorded `blocked`/`failed`. If an unowned candidate Worktree must be removed to allow a replacement, show its exact path and request current user approval before deleting it.
- **integrate <WU ID/branch>**: Inspect the completed implementation result, update it against current `main`, resolve conflicts when safe, run affected verification, merge, and record the merge and release bundle. Leave blocked, failed, or materially conflicting branches unmerged and record the evidence.

Use branch names of the form `codex/wu-<id>-<short-name>`. Only this coordinator may edit `docs/future_work.md` for active parallel work or merge to `main`.

Before reserving or spawning tasks, classify the named units by both their declared scope and possible shared substrates. Treat a unit that may change a migration/schema, shared contract, authorization policy, deployment configuration, or shared documentation file as overlapping until source-level inspection establishes otherwise. In particular, “if needed” migration work is not safe to parallelize with another unit that changes migrations or the same schema. Run dependent units in later cohorts from the updated `main` base.

For each cohort, first create the named `codex/wu-…` branches from the committed reservation base and verify their refs. Then provision one task at a time from its named branch. A returned `clientThreadId` is a pending Worktree-provisioning result: retain it, wait for the setup to resolve to a task ID and non-detached branch-owned Worktree or explicitly fail before provisioning the next task. Only after every task in the cohort is confirmed may their implementations run in parallel. Do not repeatedly poll task lists or worktree state unless a provisioning timeout, completion event, or a specific integration question requires inspection. A detached candidate Worktree or candidate without a resolved task ID is not a valid implementation environment and cannot be reused or removed without confirming no task owns it and obtaining current user approval.

An explicit `orchestrate` authorization permits routine, in-scope integration repairs such as rebasing, resolving mechanical conflicts, and renumbering a not-yet-applied migration with its directly affected references and tests. Confirm that the migration has not been applied outside the branch and that its semantics do not change; otherwise leave the unit blocked for a user decision.

Execute dependent Git and verification steps as separate commands and check each result before proceeding. Do not use PowerShell semicolon chaining for a mutation followed by another mutation or verification.

Never create implementation tasks, reserve work, merge, or push merely because units exist. Those mutations require the user to name and authorize the applicable unit(s). Never release, deploy, invoke the private Upgrade workflow, mutate cloud resources, or update the Pi unless the user separately authorizes that action.

When implementation tasks finish, report their commit SHA, changed files, verification, integration result, and remaining risks. Do not claim mocked or local verification as external acceptance.

After the coordinator records the final merged, blocked, or failed outcome and has captured the task's commit/verification/risk evidence, archive the corresponding implementation task. Do not archive it while integration, a user decision, or another requested follow-up remains. Keep the coordinator and inbox tasks active; archived implementation tasks remain available for audit or restoration.
