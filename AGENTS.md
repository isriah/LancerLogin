# LancerLogin Agent Guidance

This file supplements the repository documentation and is permanent guidance for every session in this workspace. Read it before changing product code, deployment state, or planned future work.

## Future work and planning

Read and follow [docs/future_work.md](docs/future_work.md) before recording future work, planning product work, or beginning a selected work unit.

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

## Repository safety

- Never place credentials, tokens, personal data, or biometric data in source, fixtures, screenshots, commits, or documentation.
- Do not change generated artifacts, lockfiles, migrations, environment configuration, or dependencies unless required by the selected work unit; explain why when you do.
- Preserve unrelated working-tree changes. Do not reset, discard, broadly reformat, or overwrite another change without explicit approval.
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
