# LancerLogin Development Workflow

This is the operating manual for people and Codex tasks. `AGENTS.md` contains durable safety and engineering rules; this document describes how work moves through the project.

## The normal path

```text
idea -> inbox -> triage -> ready work unit -> implement -> verify -> integrate -> release bundle -> release
```

### 1. Capture an idea

Use the **WU Idea Inbox** task, or invoke `$lancerlogin-wu-create <idea>` in a planning task. Inbox intake preserves the request without investigating or starting code. Raw entries live in `docs/idea_inbox.md` and are intentionally not committed until triage.

### 2. Triage and select work

Invoke `$lancerlogin-inbox-process` to group inbox entries, identify duplicates, and propose small work units. After approval, it records the work units in `docs/future_work.md`.

To choose work, open a task and say either:

```text
List the ready work units. Do not make changes.
```

or:

```text
Develop WU-###.
```

The selected unit is the task's contract: goal, scope, sources, acceptance criteria, verification, and release impact. A task does not start an unselected unit simply because it is ready.

### 3. Plan only when it helps

Use Plan mode before implementation when the change is ambiguous, spans multiple surfaces, needs a product or technical decision, changes a schema or migration, or is part of a larger initiative. A plan should name the outcome, affected areas, decisions, milestones, verification, and stop conditions.

For a substantial initiative, save a durable plan in `docs/PLANS/<initiative>.md`. Do not create a plan file for a focused defect or polish unit.

### 4. Implement one work unit

Use `$lancerlogin-wu-develop WU-###`. The implementation task reads the named sources, makes only in-scope changes, runs focused verification, reviews its diff, and commits the result. It reports a commit SHA, changed files, verification, and risks.

For ordinary serial work, the same task can update the WU status after its commit is safely on `main`. For parallel work, the implementation task leaves `docs/future_work.md` unchanged; the integration task updates it after the branch is merged.

### 5. Use parallel work deliberately

Parallelism is useful only for independently mergeable work. Before creating Worktree tasks, inspect the WUs' scopes and sources. Do not run units in parallel when they may overlap in a feature surface, shared component, API/data contract, migration/schema, authorization rule, deployment configuration, or shared documentation file.

Create a separate Worktree and `codex/wu-<id>-<short-name>` branch for each approved independent WU. Start them manually from their committed base. Do not use a persistent coordinator to repeatedly poll or provision an entire backlog.

When a branch is ready, invoke `$lancerlogin-integrate WU-###`. Integration is serial: inspect the handoff, update the branch against current `main`, run affected verification, merge, and record the result. Archive the implementation task only after its final evidence is recorded.

### 6. Release deliberately

Merged WUs accumulate until the user asks for a release. Invoke `$lancerlogin-release preview-unreleased` to review the eligible bundle, then `$lancerlogin-release package-unreleased` after explicitly authorizing publication. A release does not authorize private deployment or a Pi update.

## Scheduled tasks

Scheduled tasks are for stable, periodic work such as a daily CI review, a release-note draft, or a reminder to inspect a pending external result. They are not required for normal implementation, coordination, or task recovery. Keep an automation quiet when it has no actionable change or needs a user decision.

## Recovery

- **Task stalled:** inspect its branch, worktree, status, and most recent verification. Resume that same task if it has an identifiable branch and scope; otherwise mark the WU `ready` or `blocked` with evidence before starting anything new.
- **Parallel conflict:** stop integration, preserve both branches, and use Plan mode to decide the merge order or split the work.
- **Unclear idea:** keep it in the inbox and ask the minimum product question during triage.
- **Repeated mistake:** add one concise, concrete rule at the closest appropriate location in `AGENTS.md` or a task-specific guide.

## Skills

- `$lancerlogin-wu-create`: turn a request into a proposed WU; no product implementation.
- `$lancerlogin-inbox-process`: triage and promote approved inbox entries.
- `$lancerlogin-wu-develop`: implement one selected WU.
- `$lancerlogin-integrate`: review and merge one completed WU branch.
- `$lancerlogin-release`: preview or package merged unreleased WUs.

Validate a changed skill on this host:

```powershell
$env:PYTHONPATH = "$PWD\\.agents\\skill-validator-python"
$env:PYTHONUTF8 = "1"
& "C:\\Python314\\python.exe" "C:\\Users\\Izz\\.codex\\skills\\.system\\skill-creator\\scripts\\quick_validate.py" ".agents\\skills\\<skill-name>"
```
