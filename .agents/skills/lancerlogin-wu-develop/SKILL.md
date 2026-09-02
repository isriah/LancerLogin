---
name: lancerlogin-wu-develop
description: "Develop one selected LancerLogin work unit in an isolated Worktree, with its documented sources, verification, and commit handoff. Use after a coordinator reserves a work unit; do not use to coordinate or integrate parallel work."
---

# LancerLogin Work Unit

Read `AGENTS.md` and `docs/future_work.md`, then locate the work unit named by the user. Read every source the unit names before changing code.

Use this skill only for `develop <WU-ID>` in a Worktree task reserved by the coordinator. Confirm the task is in a Worktree and on the branch recorded for the unit; create the named `codex/wu-...` branch if necessary. Rename the task to `<WU-ID> — <work-unit title>`.

Implement only the selected unit. Follow its scope, acceptance criteria, verification, and the relevant project documentation. Add or update focused tests when behavior changes. Inspect the final diff against the unit's acceptance criteria, then commit the work on its branch.

Do not edit `docs/future_work.md`, change another work unit, merge or push directly to `main`, release, deploy, invoke the private Upgrade workflow, mutate cloud resources, or update the Pi. Report the commit SHA, changed files, verification, and integration risks to the coordinator. If blocked by a material decision, security issue, or overlap, stop without broadening scope and state the blocker.
