# LancerLogin Agent Guidance

This file supplements the repository documentation and is permanent guidance for every session in this workspace. Read it before changing product code, deployment state, or planned future work.

## Future work and planning

Read and follow [docs/future_work.md](docs/future_work.md) before recording future work, planning product work, or beginning a selected work unit.

## Coordinator execution

For an explicitly authorized multi-work-unit coordinator run, treat the selected ready units at the start of the run as its execution set. Use the maximum safe parallelism: separate only the units with material overlap or a real dependency into later cohorts. Integration remains serial even when implementation is parallel. Do not describe a run as “serial” merely because integration happens one branch at a time.

- Before reserving work, state the selected units, the first cohort, and why any units must wait. If the selection is `all`, it means every unit that is `ready` when the run begins; report any units excluded for another status.
- Reserve a unit only when its implementation task is about to be created. Each reserved unit must receive a fresh, separately named Worktree implementation task and its own recorded task ID, branch, and base commit. Never reuse another unit’s implementation task, agent, or worktree.
- Treat task creation as successful only after the coordinator has recorded a unique task ID, the intended branch, and its Worktree. Before retrying an uncertain task-creation response, inspect the task inventory and Worktrees. Never create a second implementation task for the same WU while another task or candidate Worktree for it exists.
- If Worktree/task creation fails, immediately record the failure and restore the unit to `ready` unless a genuine blocker requires `blocked`; do not leave a unit stranded as `in progress`.
- After a Worktree/task creation failure, do not blindly retry it. Inspect the task-creation result, task inventory, and any newly created failed-attempt worktree; retry only after identifying a concrete recoverable cause. Otherwise report the platform failure and stop that cohort. Do not delete or reuse a failed-attempt worktree without first confirming that no task owns it and obtaining current user approval.
- For each cohort, wait for every implementation task's final handoff, then integrate completed branches one at a time, update the ledger, and archive the finalized implementation task before starting dependent work from the updated `main` base.
- Do not end an authorized run, or describe it as complete, while a selected unit is still `ready` or `in progress`. Continue with the next safe cohort until every selected unit is `merged`, `blocked`, or `failed`. If the task platform interrupts execution, say so explicitly, preserve accurate ledger state, and on continuation reconcile the recorded task IDs and branches before creating anything new.
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
