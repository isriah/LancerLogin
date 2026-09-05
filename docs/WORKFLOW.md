# LancerLogin Development Workflow

This is the operating manual for people and Codex tasks. `AGENTS.md` contains durable safety and engineering rules; this document describes how work moves through the project.

## The normal path

```text
idea -> inbox -> triage -> ready work unit -> implement -> verify -> integrate -> release bundle -> release
```

### 1. Capture an idea

Use the **WU Idea Inbox** task, or invoke `$ll-wu-create <idea>` in a planning task. Inbox intake preserves the request without investigating or starting code. Raw entries live in `docs/idea_inbox.md` and are intentionally not committed until triage.

To list ideas without triaging, read `docs/idea_inbox.md`, filter `Status: untriaged`, and report each ID and `Request` verbatim. Do not invoke a workflow skill, inspect implementation, or edit either ledger.

### 2. Triage and select work

Invoke `$ll-inbox-process` to group inbox entries, identify duplicates, and propose small work units. After approval, it records the work units in `docs/future_work.md`.

An invocation that already says to promote all or named candidates is the approval; show the proposal as an interim checkpoint, then record it without asking the user to approve the same action again. Record material dependencies in the standard `Dependencies:` field.

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

### 4. Orchestrate a multi-WU goal

A request or durable goal that selects multiple WUs, `all` current WUs, or WU work plus integration or release packaging uses a coordinator task as its control plane. The selected WU IDs and authorized phases form a fixed goal snapshot; later inbox entries or WUs are excluded unless the user expands the goal. An explicit multi-WU goal authorizes creation of the supporting Codex tasks needed for those selected phases, but it does not imply deployment, cloud mutation, or Pi access.

The goal-owning task remains orchestration-only for the life of the goal. It may assess dependencies and overlap, launch and monitor tasks, ask product questions, and evaluate concise handoffs. It does not rename itself after a WU, implement or test a WU, integrate a candidate, or package the release.

For each WU, create a dedicated Worktree task and `codex/wu-<id>-<short-name>` branch. Independent WUs may form a bounded parallel cohort. Dependent or overlapping WUs still receive their own tasks, but launch only after the prerequisite or overlapping unit is integrated. Once a candidate or bounded cohort is ready, create a separate integration task for exactly those WU IDs. If release packaging is part of the goal, create a separate release task only after the goal's required WUs are merged and the release authorization and repository boundary are clear.

Use bounded task-status and wait summaries for routine monitoring. Read a task's detailed history or output only to resolve missing, stale, or conflicting handoff evidence. The coordinator asks user decisions itself, records an approved decision when required, and then launches the affected WU in a fresh implementation task.

Provisioning ambiguity is not permission for coordinator takeover. If a task returns only a client ID or detached Worktree, retain and monitor that exact evidence. Resume it when it becomes addressable. If it is conclusively inactive, preserve any candidate state, update the ledger to `ready` or `blocked`, and then launch a recorded replacement; never implement the WU in the coordinator or create a duplicate while the original may still be active.

Observable workflow checks for this mode are: every WU has a distinct task and branch; serial dependencies produce sequential tasks rather than coordinator edits; a decision-blocked WU launches only after approval; stalled provisioning does not cause inline implementation; integration and release occur in dedicated tasks; and the coordinator changes no WU production files or tests.

### 5. Implement one work unit

Use `$ll-wu-develop WU-###`. The implementation task reads the named sources, makes only in-scope changes, runs focused verification, reviews its diff, and commits the result. It reports a commit SHA, changed files, verification, and risks.

For ordinary serial work, the same task can update the WU status after its commit is safely on `main`. For parallel work, the implementation task leaves `docs/future_work.md` unchanged; the integration task updates it after the branch is merged.

Branch-local verification is candidate evidence, not the final integration result. The integration task reruns the combined affected checks after each merge and records `merged` only after those checks pass.

### 6. Use parallel work deliberately

Parallelism is useful only for independently mergeable work. Before creating Worktree tasks, inspect the WUs' scopes and sources. Do not run units in parallel when they may overlap in a feature surface, shared component, API/data contract, migration/schema, authorization rule, deployment configuration, or shared documentation file.

Create a separate Worktree and `codex/wu-<id>-<short-name>` branch for each approved independent WU. Start them manually from their committed base. Outside an explicitly authorized multi-WU goal, do not use a persistent coordinator to repeatedly poll or provision an entire backlog. Inside such a goal, the coordinator is limited to the fixed goal snapshot and the orchestration-only rules above.

Assess overlap at the contract and edited-region level, not just by broad files such as `index.ts` or a centralized test file. Record branch, base, and Worktree before implementation starts. `npm run test:browser` assigns a worktree-specific cache and port range, so independent browser checks can run concurrently without attaching to another task's fixture server.

To assess the whole ready ledger, use `$ll-coordinator assess all`. To approve its immediately preceding recommended first batch without retyping IDs, reply `$ll-coordinator launch suggested`. The coordinator rechecks that suggestion against the current ledger before creating any tasks; if it has become stale, it shows a fresh assessment instead of launching.

When a branch is ready, invoke `$ll-integrate WU-###`. A dedicated integration task may name a bounded cohort, for example `$ll-integrate WU-061 WU-066`; it integrates only those candidates serially. Integration inspects each handoff, updates the branch against current `main`, runs affected verification, merges, and records the result. Archive the implementation task only after its final evidence is recorded.

To inspect several completed branches without making changes, use `$ll-integrate preview all`; it reports the safe serial merge order and includes explicitly recorded detached candidates. Use `$ll-integrate all` to authorize immediate integration of every eligible candidate. It reports the order and exclusions, revalidates each candidate before merging it, and stops at the first stale record, missing evidence, conflict, or failed verification.

When `$ll-start` completes a selected phase, its final report includes a short **Valid next commands** section based on the resulting state. It distinguishes commands that can be issued immediately from conditional follow-ups. For example, while a newly created implementation task is provisioning or running, checking that task or invoking `$ll-start` to refresh the overall state is valid immediately; `$ll-integrate preview all` is listed only as a later command after the implementation produces an eligible candidate. Context-dependent shortcuts such as `$ll-coordinator launch suggested` must not be presented unless their required preceding assessment occurred in the same task.

### 7. Release deliberately

Merged WUs accumulate until the user asks for a release. Invoke `$ll-release preview-unreleased` to review the eligible bundle, then `$ll-release package-unreleased` after explicitly authorizing publication. A release does not authorize private deployment or a Pi update.

Before release preparation, state and verify the authorized Git remote and GitHub repository. Production publication requires explicit production authorization; a sandbox rehearsal uses only its named sandbox remote/repository and a never-reused prerelease version.

## Verification ladder

1. During implementation, run the smallest affected `verify:<area>` command and focused browser tests for changed interactions.
2. During integration, rerun every affected area check and the combined browser smoke when branches touched browser behavior or fixtures.
3. Before release, run `npm run verify:release` locally. It runs the full repository gate and the bounded high-severity audit of the complete lockfile.
4. On GitHub, require the exact commit's complete **Verify** workflow. Release-candidate commits use the `Release vX.Y.Z` subject so the selective dependency-audit job is forced even when no dependency manifest changed.

## Scheduled tasks

Scheduled tasks are for stable, periodic work such as a daily CI review, a release-note draft, or a reminder to inspect a pending external result. They are not required for normal implementation, coordination, or task recovery. Keep an automation quiet when it has no actionable change or needs a user decision.

## Recovery

- **Task stalled:** inspect its branch, worktree, status, and most recent verification. Resume that same task if it has an identifiable branch and scope; otherwise prove it is inactive, preserve any candidate state, and mark the WU `ready` or `blocked` with evidence before starting a recorded replacement. A multi-WU goal coordinator never completes the implementation itself.
- **Parallel conflict:** stop integration, preserve both branches, and use Plan mode to decide the merge order or split the work.
- **Browser smoke failed:** distinguish an assertion failure from startup/cache/port failure. Keep the failing trace, verify the target server belongs to the current worktree, and rerun only after correcting isolation or the product defect. Do not silently reuse an existing fixture server.
- **Dependency audit timed out:** rerun the failed GitHub job once. If the same bounded lockfile audit times out again, treat it as a deterministic gate problem and repair the audit path without omitting dependency classes or lowering severity.
- **Unclear idea:** keep it in the inbox and ask the minimum product question during triage.
- **Repeated mistake:** add one concise, concrete rule at the closest appropriate location in `AGENTS.md` or a task-specific guide.

## Skills

- `$ll-start`: orient or resume a task, triage current ideas, and let the user immediately integrate, promote and launch, or start the best viable work batch.
- `$ll-wu-create`: turn a request into a proposed WU; no product implementation.
- `$ll-inbox-process`: triage and promote approved inbox entries.
- `$ll-wu-develop`: implement one selected WU.
- `$ll-integrate`: review and merge one completed WU branch, preview a completed batch, or integrate every eligible candidate.
- `$ll-coordinator`: assess or launch a compatible implementation batch.
- `$ll-release`: preview or package merged unreleased WUs.

Validate a changed skill on this host:

```powershell
$env:PYTHONPATH = "$PWD\\.agents\\skill-validator-python"
$env:PYTHONUTF8 = "1"
& "C:\\Python314\\python.exe" "C:\\Users\\Izz\\.codex\\skills\\.system\\skill-creator\\scripts\\quick_validate.py" ".agents\\skills\\<skill-name>"
```
