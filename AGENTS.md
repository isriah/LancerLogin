# LancerLogin Agent Guidance

This file supplements the repository documentation and is permanent guidance for every session in this workspace. Read it before changing product code, deployment state, or the feedback queue.

## Feedback and planning

- Treat feedback, UI observations, defects, and feature requests as entries in a running feedback queue by default. Do **not** immediately implement them, create a release, or deploy them merely because they were reported.
- Record each item with the affected area, observed behavior, expected behavior, and any supplied screenshot or link. Use the current dated file in `docs/feedback/`, or create a new dated file when a new round begins.
- Ask clarifying questions only when needed to accurately record an item or when a material product, security, or design decision cannot be reasonably inferred.
- Start implementation only when the user explicitly authorizes the item or a reconciled batch for execution.
- Before implementation, inspect the current queue. If its scope, priority, desired behavior, or release boundary is uncertain, ask the necessary questions and provide a concise execution plan. Do not add planning friction when the request and queue are already clear.
- Once an authorized, unambiguous batch begins, work through implementation, tests, documentation, release, and the requested deployment without arbitrary pauses. Pause only for genuine missing input, required approval, or a blocker.

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
- Only run the private adopter deployment workflow when the user explicitly requests deployment. When dispatching it in a browser, prepare the form first and ask for confirmation immediately before the final **Run workflow** click.
- Do not update the Pi unless the user specifically includes it in the requested deployment.
