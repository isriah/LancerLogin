# LancerLogin Agent Guidance

This file supplements the repository documentation and is permanent guidance for every session in this workspace. Read it before changing product code, deployment state, or planned future work.

## Future work and planning

Read and follow [docs/future_work.md](docs/future_work.md) before recording future work, planning product work, or beginning a selected work unit.

### Idea intake

`docs/idea_inbox.md` is the durable, canonical intake for untriaged observations, defects, feature requests, and documentation ideas. The Codex task titled **WU Idea Inbox** is the conversational front door for that file, not the source of record.

- In the **WU Idea Inbox** task, when the user supplies an idea, append a new raw entry to `docs/idea_inbox.md` and commit that intake-only change. Preserve the user's request; do not investigate, group, create a work unit, modify product code, or change deployment state there.
- Assign each entry the next `IN-###` ID and leave it `untriaged`. A single message may be one raw entry even when it contains several related thoughts; inbox processing decides whether to split it.
- Only `$lancerlogin-inbox-process`, running in the coordinator task, may change an intake entry from `untriaged` to `covered`, `promoted`, or `discarded`. It records the corresponding WU IDs or rationale and commits those status changes with the ledger update.
- Do not use task-message history, a task preview, or an assistant acknowledgement as evidence that an idea was captured. If an inbox message cannot be recorded in `docs/idea_inbox.md`, say so and ask the user to retry; never silently accept it.

## Coordinator execution

For an explicitly authorized multi-work-unit coordinator run, treat the selected ready units at the start of the run as its execution set. Use the maximum safe parallelism: separate only the units with material overlap or a real dependency into later cohorts. Integration remains serial even when implementation is parallel. Do not describe a run as “serial” merely because integration happens one branch at a time.

- Before reserving work, state the selected units, the first cohort, and why any units must wait. If the selection is `all`, it means every unit that is `ready` when the run begins; report any units excluded for another status.
- Reserve a unit only when its implementation task is about to be created. Each reserved unit must receive a fresh, separately named Worktree implementation task and its own recorded task ID, branch, and base commit. Never reuse another unit’s implementation task, agent, or worktree.
- Treat task creation as successful only after the coordinator has recorded a unique task ID, the intended branch, and its Worktree. Before retrying an uncertain task-creation response, inspect the task inventory and Worktrees. Never create a second implementation task for the same WU while another task or candidate Worktree for it exists.
- A returned `clientThreadId` means Worktree setup is still pending, not that creation failed. Record it as pending and wait for a resolved task ID or an explicit provisioning failure before reserving another unit or retrying that WU.
- If Worktree/task creation fails, immediately record the failure and restore the unit to `ready` unless a genuine blocker requires `blocked`; do not leave a unit stranded as `in progress`.
- After a Worktree/task creation failure, do not blindly retry it. Inspect the task-creation result, task inventory, and any newly created failed-attempt worktree; retry only after identifying a concrete recoverable cause. Otherwise report the platform failure and stop that cohort. Do not delete or reuse a failed-attempt worktree without first confirming that no task owns it and obtaining current user approval.
- Treat the ledger's recorded implementation task ID, branch, base commit, and status as the durable run state; a coordinator's current chat turn, sidebar availability, or ability to accept a new prompt is not evidence that a child task has finished.
- For each cohort, wait for every implementation task's final handoff, then integrate completed branches one at a time, update the ledger, and archive the finalized implementation task before starting dependent work from the updated `main` base. A child task that has committed changes but has not supplied a final handoff is still `in progress` and must be reconciled rather than assumed complete.
- If a coordinator turn ends, is interrupted by a user message, times out, or resumes after any pause while its execution set has a `ready` or `in progress` unit, the next turn must begin by reconciling every selected unit: inspect each recorded task, branch, and worktree; record its current outcome; then continue the run from the next safe step. Do this before creating a task, reserving another unit, or reporting status.
- Do not end an authorized run, or describe it as complete, while a selected unit is still `ready` or `in progress`. Continue with the next safe cohort until every selected unit is `merged`, `blocked`, or `failed`. If a coordinator must return control before that point, clearly label the run `interrupted` and state the exact active task IDs, ledger statuses, and one resume instruction; never imply that an available chat is an idle or completed run.
- A blocked or failed unit does not prevent unrelated selected units from continuing. Report its evidence and continue with the next safe cohort; ask the user only when the remaining work needs a material decision.

## Project orientation

Before a change, identify the affected surface and read the relevant documentation:

- Architecture and system boundaries: `docs/ARCHITECTURE.md`
- Local setup and focused verification: `docs/DEVELOPMENT.md`
- Product and operational decisions: `docs/DECISIONS.md`
- Kiosk behavior and hardware constraints: `docs/KIOSK.md`
- Release process: `docs/RELEASE-CHECKLIST.md`

Do not read every document by default; read the documents relevant to the selected work unit.

## Definition of done

For each selected work unit:

- Make only in-scope changes.
- Add or update tests when behavior changes or a regression can be captured.
- Run the focused verification documented in `docs/DEVELOPMENT.md`.
- Review the final diff for regressions, unintended scope, security issues, and missing documentation.
- For serial work, update the related work unit with merge and release-bundle status. For parallel work, report the outcome to the integration task; only that task updates the shared work-unit ledger after merge.
- Report changed files, verification run, and any remaining risk or manual validation.

## Structured decisions

When a task needs a specific decision from the user before it can safely continue—such as approval, a product or design choice, a version number, scope selection, or a migration-integration decision—present it in Plan mode as a structured choice prompt when that mode is available.

- Ask one decision at a time and state the consequence of the choice briefly.
- Offer two or three mutually exclusive options, put the recommended option first, and allow the user to supply an alternative.
- Do not use a structured prompt for routine, already-authorized implementation or integration work.
- Once the user selects an option, continue within that authorization without asking again for the same decision.
- If the active task cannot use Plan mode, stop and ask the same concise question in chat; do not imitate clickable controls with Markdown.

## Repository safety

- Never place credentials, tokens, personal data, or biometric data in source, fixtures, screenshots, commits, or documentation.
- Do not change generated artifacts, lockfiles, migrations, environment configuration, or dependencies unless required by the selected work unit; explain why when you do.
- Preserve unrelated working-tree changes. Do not reset, discard, broadly reformat, or overwrite another change without explicit approval.
- `.codex-remote-attachments/` is an expected, user-managed untracked folder for Codex remote/mobile attachments. Leave it in place, do not repeatedly report it as an unrelated change, and never stage or modify it unless the user explicitly asks.
- Treat migrations, authentication/authorization, updater behavior, and Pi-facing changes as high risk: add focused verification and cite the relevant design documentation.

## Git and review

- Prefer small, single-purpose commits that correspond to one work unit.
- Before committing, inspect `git diff` and `git status`; include only intended files.
- For dependent shell steps, run each mutation and its verification as separate commands and check the result before continuing. Do not use PowerShell semicolon chaining for dependent Git operations or for a mutation followed by verification.
- Complete a selected work unit with the commit and merge process defined in `docs/future_work.md`. Do not include unrelated working-tree changes.
- For parallel work units, use separate worktrees and branches. Implementation tasks do not modify the shared work-unit ledger or merge directly to `main`; the integration task merges one completed branch at a time.
- For a behavior-changing change, review it against its acceptance criteria, not only whether tests pass.
- When Codex makes the same kind of mistake twice, add a short, concrete rule to the closest applicable `AGENTS.md` or linked guide.

## Skill validation

The bundled skill validator uses PyYAML from the ignored local `.agents/skill-validator-python/` directory and requires UTF-8 mode on this Windows host. Validate a changed skill with:

```powershell
$env:PYTHONPATH = "$PWD\.agents\skill-validator-python"
$env:PYTHONUTF8 = "1"
& "C:\Python314\python.exe" "C:\Users\Izz\.codex\skills\.system\skill-creator\scripts\quick_validate.py" ".agents\skills\<skill-name>"
```

## GitHub CLI

- GitHub CLI is installed and authenticated on this Windows host. Use its absolute path so a stale Codex terminal `PATH` can never block normal work:

  ```powershell
  & "C:\Program Files\GitHub CLI\gh.exe"
  ```

- Before diagnosing a GitHub CLI availability issue, run the command above with `--version` or `auth status`. Do not claim `gh` is missing because bare `gh` is unavailable in an inherited shell.
- Use the direct executable for release checks, workflow status, and reruns. Public release verification must still succeed for the exact commit before tagging; never workaround a failed release gate by changing the tag or version without diagnosing it.

## Raspberry Pi SSH

- The verified key-based SSH configuration is `ssh lancerlogin-pi`.
- Its non-secret resolved settings are user `attkiosk`, host `attkiosk.local`, and identity file `~/.ssh/lancerlogin_pi`. Confirm the configuration, when needed, with:

  ```powershell
  ssh -G lancerlogin-pi
  ```

- Do not use the Windows login name or the retired `izz` account for Pi SSH. Never put a password into a command, shell history, source file, log, or chat response; SSH should prompt interactively only when key authentication is unavailable.
- Pi changes, service restarts, and remote deployments require an explicit current user request. First inspect status, keep changes narrow, and do not erase local R503 mappings or templates.

## Releases and private deployment

- Keep releases in the `0.n.n` namespace. Use `0.n.X` for narrowly scoped fixes; reserve `1.0.0` for a user-approved major release.
- For a release: run focused verification, run the complete release gate, commit/push, wait for the exact-commit public GitHub Verify workflow, then create/push the matching `v0.n.n` tag and wait for the immutable public release build.
- Only run the private adopter deployment workflow when the user explicitly requests deployment or has authorized the current change round to update the installation. When dispatching it in a browser, prepare the form first and ask for confirmation immediately before the final **Run workflow** click only because browser safety requires that action-time confirmation.
- Do not update the Pi unless the user specifically includes it in the requested deployment.
