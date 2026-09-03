---
name: lancerlogin-coordinator
description: "Assess a selected LancerLogin work-unit batch for safe parallel execution and provide launch or integration guidance. Do not run an autonomous backlog."
---

# LancerLogin Batch Planner

Read `AGENTS.md`, `docs/WORKFLOW.md`, and `docs/future_work.md` before acting. This skill helps the user prepare a small, explicitly selected batch; it is not a persistent coordinator.

Interpret the requested mode from the remaining prompt text. Accept individual WU IDs, `all` (every unit currently `ready`), or an inclusive range such as `WU-011..WU-018`. Expand the selection immediately before responding and identify non-ready or invalid units.

- **list [selector]**: Read-only. Show the selected units' goal, scope, sources, verification, release impact, and likely overlap.
- **assess <selector>**: Determine which selected ready units are safe to run in parallel. Inspect the named sources where a shared surface is plausible. State a first parallel batch and the units that must wait, with reasons.
- **launch <selector>**: Use only after explicit user authorization. First perform `assess`, then create a separate named Worktree task for each approved independent unit. Record its branch and task evidence in the ledger before starting it. Do not wait, poll, retry task provisioning automatically, or launch a later cohort.
- **integrate <WU-ID>**: Invoke `$lancerlogin-integrate <WU-ID>` and follow that skill.

Treat a possible overlap in a migration/schema, shared contract, authorization policy, deployment configuration, or shared documentation as serial until inspection proves otherwise. Each implementation task has exactly one WU, one branch, and one Worktree. Never create a duplicate task for an active WU.

This skill does not create scheduled tasks, maintain `docs/coordinator_state.md`, run checkpoints, auto-recover task provisioning, or execute an entire backlog. Never release, deploy, mutate cloud resources, or update the Pi without separate explicit authorization.
