# LancerLogin Development Workflow

This is the operating manual for people and Codex tasks. `AGENTS.md` contains durable safety and engineering rules; this document describes how work moves through the project.

## The normal path

```text
idea -> inbox -> triage -> ready work unit -> implement -> verify -> integrate -> release bundle -> release
```

### 1. Capture an idea

Use the **WU Idea Inbox** task, or invoke `$ll-wu-create <idea>` in a planning task. Inbox intake preserves the request without investigating or starting code. Raw entries live in `docs/idea_inbox.md` and are intentionally not committed until triage.

### 2. Triage and select work

Invoke `$ll-inbox-process` to group inbox entries, identify duplicates, and propose small work units. After approval, it records the work units in `docs/future_work.md`.

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

Use `$ll-wu-develop WU-###`. The implementation task reads the named sources, makes only in-scope changes, runs focused verification, reviews its diff, and commits the result. It reports a commit SHA, changed files, verification, and risks.

For ordinary serial work, the same task can update the WU status after its commit is safely on `main`. For parallel work, the implementation task leaves `docs/future_work.md` unchanged; the integration task updates it after the branch is merged.

### 5. Use parallel work deliberately

Parallelism is useful only for independently mergeable work. Before creating Worktree tasks, inspect the WUs' scopes and sources. Do not run units in parallel when they may overlap in a feature surface, shared component, API/data contract, migration/schema, authorization rule, deployment configuration, or shared documentation file.

Create a separate Worktree and `codex/wu-<id>-<short-name>` branch for each approved independent WU. Start them manually from their committed base. Do not use a persistent coordinator to repeatedly poll or provision an entire backlog.

To assess the whole ready ledger, use `$ll-coordinator assess all`. To approve its immediately preceding recommended first batch without retyping IDs, reply `$ll-coordinator launch suggested`. The coordinator rechecks that suggestion against the current ledger before creating any tasks; if it has become stale, it shows a fresh assessment instead of launching.

When a branch is ready, invoke `$ll-integrate WU-###`. Integration is serial: inspect the handoff, update the branch against current `main`, run affected verification, merge, and record the result. Archive the implementation task only after its final evidence is recorded.

To integrate several completed branches without retyping IDs, use `$ll-integrate all`. It proposes the safe serial merge order and includes explicitly recorded detached candidates, but makes no changes. Approve its immediately preceding proposal with `$ll-integrate suggested`; it revalidates every candidate and stops at the first conflict or failed verification.

### 6. Release deliberately

Merged WUs accumulate until the user asks for a release. Invoke `$ll-release preview-unreleased` to review the eligible bundle, then `$ll-release package-unreleased` after explicitly authorizing publication. A release does not authorize private deployment or a Pi update.

## Scheduled tasks

Scheduled tasks are for stable, periodic work such as a daily CI review, a release-note draft, or a reminder to inspect a pending external result. They are not required for normal implementation, coordination, or task recovery. Keep an automation quiet when it has no actionable change or needs a user decision.

## Recovery

- **Task stalled:** inspect its branch, worktree, status, and most recent verification. Resume that same task if it has an identifiable branch and scope; otherwise mark the WU `ready` or `blocked` with evidence before starting anything new.
- **Parallel conflict:** stop integration, preserve both branches, and use Plan mode to decide the merge order or split the work.
- **Unclear idea:** keep it in the inbox and ask the minimum product question during triage.
- **Repeated mistake:** add one concise, concrete rule at the closest appropriate location in `AGENTS.md` or a task-specific guide.

## Skills

- `$ll-start`: orient or resume a task, triage current ideas, and let the user immediately integrate, promote and launch, or start the best viable work batch.
- `$ll-wu-create`: turn a request into a proposed WU; no product implementation.
- `$ll-inbox-process`: triage and promote approved inbox entries.
- `$ll-wu-develop`: implement one selected WU.
- `$ll-integrate`: review and merge one completed WU branch, or assess/approve a completed batch.
- `$ll-coordinator`: assess or launch a compatible implementation batch.
- `$ll-release`: preview or package merged unreleased WUs.

Validate a changed skill on this host:

```powershell
$env:PYTHONPATH = "$PWD\\.agents\\skill-validator-python"
$env:PYTHONUTF8 = "1"
& "C:\\Python314\\python.exe" "C:\\Users\\Izz\\.codex\\skills\\.system\\skill-creator\\scripts\\quick_validate.py" ".agents\\skills\\<skill-name>"
```
