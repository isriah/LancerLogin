# LancerLogin Agent Guidance

This file contains durable rules for every task in this repository. Read the task-specific documentation named below before changing that surface. For the day-to-day process and copyable prompts, read [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Orient before changing code

- Planned work: [docs/future_work.md](docs/future_work.md)
- Raw ideas: [docs/idea_inbox.md](docs/idea_inbox.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Development and focused verification: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Product and operational decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Kiosk behavior and hardware constraints: [docs/KIOSK.md](docs/KIOSK.md)
- Releases: [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)

Read only the documentation relevant to the selected work. Use Plan mode before code changes when a request is ambiguous, materially multi-step, or has a product, security, migration, or architecture decision.

## Work-unit rules

- A work unit is one independently reviewable outcome. Do not begin one just because it is listed; the user must select or authorize it.
- One implementation task normally owns one work unit and one branch. Use a Worktree only when work runs in parallel or must be isolated from the local checkout.
- Before parallel work, compare code areas, shared contracts, migrations, authorization, deployment configuration, and shared documentation. Run overlapping units serially.
- Implementation tasks do not edit the shared ledger, merge to `main`, release, deploy, mutate cloud resources, or update the Pi. The task that performs integration records the merge in the ledger.
- Parallel implementation commits must start with their WU ID, for example `WU-019: clarify contest resolution failures`. If task provisioning creates a detached Worktree or lacks an addressable task ID, record it as a candidate for review; do not create a duplicate implementation task.

## Definition of done

- Keep changes within the selected scope and acceptance criteria.
- Add or update focused tests when behavior changes or a regression can be captured.
- Run the focused verification documented in `docs/DEVELOPMENT.md`.
- Inspect the final diff for scope, regressions, security, and documentation gaps.
- Commit a small, single-purpose change and report the commit, changed files, verification, and remaining risks.

## Repository safety

- Never put credentials, tokens, personal data, or biometric data in code, fixtures, screenshots, commits, or documentation.
- Preserve unrelated working-tree changes. Do not reset, discard, broadly reformat, or overwrite another change without explicit approval.
- `.codex-remote-attachments/` is expected user-managed content. Do not stage, modify, or repeatedly report it.
- Treat migrations, authentication/authorization, updater behavior, and Pi-facing changes as high risk: read the relevant design documentation and add focused verification.
- Do not change generated artifacts, lockfiles, migrations, environment configuration, or dependencies unless the selected work requires it; explain why when you do.

## Git, releases, and deployment

- Prefer small, single-purpose commits. Inspect `git status` and `git diff` before committing; include only intended files.
- Run dependent shell mutations and verification as separate commands. Do not use PowerShell semicolon chaining for dependent Git operations.
- Releases require explicit user authorization and follow `docs/RELEASE-CHECKLIST.md`. A merged work unit is not a release.
- A private adopter deployment, Pi update, service restart, or cloud-resource mutation requires an explicit current user request.
- Use `ssh lancerlogin-pi` for Pi access; never include passwords in commands, files, logs, or chat.

## Skills and decisions

- Use the repository skills for repeatable inbox, work-unit, integration, and release procedures. Validate any changed skill using the command in `docs/WORKFLOW.md`.
- When a material user decision is required, use a structured Plan-mode question when available. Ask one decision at a time, give a recommended option and its consequence, and do not imitate clickable controls in Markdown.

## GitHub CLI

Use `& "C:\\Program Files\\GitHub CLI\\gh.exe"` for GitHub CLI commands. Verify the exact commit's public workflow before creating a release tag; never change a version or tag to bypass a failed release gate.
