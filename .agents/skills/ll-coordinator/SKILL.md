---
name: ll-coordinator
description: "Assess and launch selected LancerLogin work-unit tasks safely, including successive cohorts for an explicitly authorized multi-WU goal. Do not run an unselected backlog or implement work units."
---

# LancerLogin Batch Planner

Read `AGENTS.md` and `docs/WORKFLOW.md`, then scan `docs/future_work.md` for active statuses and dependencies before reading the full selected entries. This skill normally prepares a small, explicitly selected batch. When the task owns an explicitly authorized multi-WU goal, it may reassess and launch successive cohorts from that goal's fixed snapshot across turns; this exception does not authorize processing an unselected or newly added backlog.

Interpret the requested mode from the remaining prompt text. Accept individual WU IDs, `all` (every unit currently `ready`), or an inclusive range such as `WU-011..WU-018`. Expand the selection immediately before responding and identify non-ready or invalid units.

- **list [selector]**: Read-only. Show the selected units' goal, scope, sources, verification, release impact, and likely overlap.
- **assess <selector>**: Determine which selected ready units are safe to run in parallel. Honor `Dependencies:` first. Inspect the named sources where a shared surface is plausible, distinguishing actual contract/edited-region overlap from unrelated regions in a large file. State a first parallel batch and the units that must wait, with reasons.
- **launch <selector>**: Use only after explicit user authorization. First perform `assess`, then create a separate named Worktree task for each approved independent unit. Give each task a prompt that requires a `WU-###:` commit subject. Record its branch, base, Worktree, and provisioning evidence in the ledger before starting it. Browser tests use `npm run test:browser`, which isolates cache and ports per worktree. If task creation exposes only a client ID or detached Worktree, record that candidate evidence; do not claim a confirmed implementation task, create a duplicate, or launch a later cohort.
- **launch suggested**: Treat this as approval of the first parallel batch proposed by the immediately preceding `assess` response in this same task. Re-read the ledger and verify that every proposed WU is still `ready`, no new active WU overlaps it, and the selection has not changed. If it is still valid, launch exactly that batch. Otherwise, do not launch anything; provide a fresh assessment and wait for approval.
- **integrate <WU-ID>**: Invoke `$ll-integrate <WU-ID>` in this task and follow that skill. For a multi-WU goal, this preserves the coordinator as the trusted authorization boundary.

In a multi-WU goal task, remain the coordinator and trusted authorization boundary. Create one dedicated Worktree task for every WU, including units that must run serially. State in each implementation prompt that the assignment authorizes implementation, verification, and a candidate commit for only that WU, without another approval prompt. Use bounded task-status and wait summaries and ask product decisions in the goal task. Integrate eligible named candidates here with `$ll-integrate`, and package an explicitly authorized bundle here with `$ll-release`. Never rename the coordinator after a WU, invoke `$ll-wu-develop` in it, or edit or test WU implementation code.

Use `$ll-integrate preview all` for a read-only integration assessment and `$ll-integrate all` to authorize immediate serial integration of every eligible candidate. Do not provide a separate coordinator integration mode.

Treat a possible overlap in a migration/schema, shared contract, authorization policy, deployment configuration, or shared documentation as serial until inspection proves otherwise. Each implementation task has exactly one WU, one branch, and one Worktree. Never create a duplicate task for an active WU.

This skill does not create scheduled tasks, maintain `docs/coordinator_state.md`, run checkpoints, auto-recover task provisioning, or execute an unselected backlog. For stalled provisioning, retain and monitor the recorded task/client/worktree; if it is conclusively inactive, preserve its state and return the WU to `ready` or `blocked` before launching a recorded replacement. Never take over implementation in the coordinator. Never release, deploy, mutate cloud resources, or update the Pi without separate explicit authorization.
