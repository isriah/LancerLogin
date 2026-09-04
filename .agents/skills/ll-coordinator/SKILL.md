---
name: ll-coordinator
description: "Assess a selected LancerLogin work-unit batch for safe parallel execution and provide launch or integration guidance. Do not run an autonomous backlog."
---

# LancerLogin Batch Planner

Read `AGENTS.md` and `docs/WORKFLOW.md`, then scan `docs/future_work.md` for active statuses and dependencies before reading the full selected entries. This skill helps the user prepare a small, explicitly selected batch; it is not a persistent coordinator.

Interpret the requested mode from the remaining prompt text. Accept individual WU IDs, `all` (every unit currently `ready`), or an inclusive range such as `WU-011..WU-018`. Expand the selection immediately before responding and identify non-ready or invalid units.

- **list [selector]**: Read-only. Show the selected units' goal, scope, sources, verification, release impact, and likely overlap.
- **assess <selector>**: Determine which selected ready units are safe to run in parallel. Honor `Dependencies:` first. Inspect the named sources where a shared surface is plausible, distinguishing actual contract/edited-region overlap from unrelated regions in a large file. State a first parallel batch and the units that must wait, with reasons.
- **launch <selector>**: Use only after explicit user authorization. First perform `assess`, then create a separate named Worktree task for each approved independent unit. Give each task a prompt that requires a `WU-###:` commit subject. Record its branch, base, Worktree, and provisioning evidence in the ledger before starting it. Browser tests use `npm run test:browser`, which isolates cache and ports per worktree. If task creation exposes only a client ID or detached Worktree, record that candidate evidence; do not claim a confirmed implementation task, create a duplicate, or launch a later cohort.
- **launch suggested**: Treat this as approval of the first parallel batch proposed by the immediately preceding `assess` response in this same task. Re-read the ledger and verify that every proposed WU is still `ready`, no new active WU overlaps it, and the selection has not changed. If it is still valid, launch exactly that batch. Otherwise, do not launch anything; provide a fresh assessment and wait for approval.
- **integrate <WU-ID>**: Invoke `$ll-integrate <WU-ID>` and follow that skill.

Use `$ll-integrate preview all` for a read-only integration assessment and `$ll-integrate all` to authorize immediate serial integration of every eligible candidate. Do not provide a separate coordinator integration mode.

Treat a possible overlap in a migration/schema, shared contract, authorization policy, deployment configuration, or shared documentation as serial until inspection proves otherwise. Each implementation task has exactly one WU, one branch, and one Worktree. Never create a duplicate task for an active WU.

This skill does not create scheduled tasks, maintain `docs/coordinator_state.md`, run checkpoints, auto-recover task provisioning, or execute an entire backlog. Never release, deploy, mutate cloud resources, or update the Pi without separate explicit authorization.
