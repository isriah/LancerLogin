---
name: ll-wu-develop
description: "Develop one selected LancerLogin work unit with its documented sources, verification, and commit handoff. Use for implementation, not inbox triage, releases, or unrelated work."
---

# LancerLogin Work Unit

Read `AGENTS.md`, `docs/WORKFLOW.md`, and `docs/future_work.md`, then locate the selected WU. Read every source the WU names before changing code. Rename the task to `<WU-ID> — <work-unit title>` when task controls are available.

Confirm the unit is `ready` or explicitly assigned to this task. For parallel work, confirm the task is in its dedicated Worktree and the recorded `codex/wu-...` branch. For serial work, use the branch/check-out the user authorized; do not create unrelated branches or tasks.

Implement only the selected unit. Follow its scope, acceptance criteria, verification, and relevant product documentation. Add or update focused tests for behavior changes. Inspect the final diff against acceptance criteria, then commit the work.

For a parallel branch, do not edit `docs/future_work.md` or merge. Report the commit SHA, changed files, verification, and integration risks for `$ll-integrate`. For a serial local change that the user authorized on `main`, update the WU to `merged` only after the commit is safely on `main` and record its release impact.

If blocked by a material decision, security issue, or overlap, stop without broadening scope and state the blocker. Never release, deploy, mutate cloud resources, or update the Pi without separate explicit authorization.
