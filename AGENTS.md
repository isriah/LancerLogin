# LancerLogin Agent Guidance

This file contains durable rules for every task in this repository. Read the task-specific documentation named below before changing that surface. For the day-to-day process and copyable prompts, read [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Orient before changing code

- Planned work: [docs/future_work.md](docs/future_work.md)
- Raw ideas: [docs/idea_inbox.md](docs/idea_inbox.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Development and focused verification: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Dashboard visual language: [docs/UI-STANDARDS.md](docs/UI-STANDARDS.md)
- Product and operational decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Kiosk behavior and hardware constraints: [docs/KIOSK.md](docs/KIOSK.md)
- Releases: [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)

Read only the documentation relevant to the selected work. Use Plan mode before code changes when a request is ambiguous, materially multi-step, or has a product, security, migration, or architecture decision.

Before planning or changing dashboard presentation, read `docs/UI-STANDARDS.md`. Its planning and review checklist is required for touched dashboard UI; existing inconsistencies outside the selected work remain out of scope.

For a list-only request, read `docs/idea_inbox.md`, report the `untriaged` IDs and requests verbatim, and stop. Listing does not authorize triage, ledger edits, or `$ll-start`.

## Work-unit rules

- A work unit is one independently reviewable outcome. Do not begin one just because it is listed; the user must select or authorize it.
- Record material dependencies explicitly with `Dependencies:`; a blocked unit names the exact dependency or decision that must clear it.
- One implementation task owns one work unit and one branch. Use a Worktree when work runs in parallel, must be isolated from the local checkout, or belongs to a multi-WU goal.
- Before parallel work, compare code areas, shared contracts, migrations, authorization, deployment configuration, and shared documentation. Run overlapping units serially.
- Implementation tasks do not edit the shared ledger, merge to `main`, release, deploy, mutate cloud resources, or update the Pi. The task that performs integration records the merge in the ledger.
- Parallel implementation commits must start with their WU ID, for example `WU-019: clarify contest resolution failures`. If task provisioning creates a detached Worktree or lacks an addressable task ID, record it as a candidate for review; do not create a duplicate implementation task.

## Multi-WU goal orchestration

- A user request or durable goal that explicitly selects at least two WUs, `all` WUs, or WU implementation plus integration or release packaging is a multi-WU goal. It authorizes supporting Codex tasks for only that selected scope; release, deployment, cloud mutation, and Pi work still require the explicit authorization stated elsewhere in this file.
- The task that owns a multi-WU goal is the coordinator and trusted authorization boundary. Preserve that identity and context: do not rename it to a WU, invoke `$ll-wu-develop` in it, edit WU production code or tests, or run WU implementation suites. After implementation handoffs, perform user-authorized integration and release packaging in this coordinator so the mutations retain the original user instruction's provenance.
- Create one dedicated Worktree task per WU. Independent WUs may run in parallel; overlapping or dependent WUs still use separate tasks but start serially after their prerequisites are integrated.
- A coordinator-created implementation task may implement, verify, and commit only its named WU without asking the user to repeat the coordinator's authorization. It returns material decisions, scope changes, and integration or release work to the coordinator.
- The coordinator invokes the integration and release skills itself for phases explicitly authorized in the user's goal. Do not create integration or release sub-tasks whose delegated prompts would require the user to repeat approval. Release, deployment, cloud mutation, and Pi work still require the explicit authorization stated elsewhere in this file.
- Keep orchestration context compact: use task status and bounded wait summaries, read full task history or command output only when a handoff is incomplete or contradictory, and archive a WU task only after integration records its final evidence.
- A stalled or detached implementation never falls back to inline work in the goal task. Resume the recorded task when addressable; otherwise prove it is no longer active, preserve or record its candidate state, return the WU to `ready` or `blocked` as appropriate, and only then launch a clearly identified replacement. Never duplicate an active WU.

## Definition of done

- Keep changes within the selected scope and acceptance criteria.
- Add or update focused tests when behavior changes or a regression can be captured.
- Run the focused verification documented in `docs/DEVELOPMENT.md`.
- Treat branch-local checks as candidate evidence. After integration, rerun the combined affected checks before recording a unit as merged.
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
- Before any push, tag, workflow wait, or GitHub Release, name the authorized remote and repository and verify their URLs. Never infer that `origin` is an authorized release target.
- Run dependent shell mutations and verification as separate commands. Do not use PowerShell semicolon chaining for dependent Git operations.
- Releases require explicit user authorization and follow `docs/RELEASE-CHECKLIST.md`. A merged work unit is not a release.
- A private adopter deployment, Pi update, service restart, or cloud-resource mutation requires an explicit current user request.
- Use `ssh lancerlogin-pi` for Pi access; never include passwords in commands, files, logs, or chat.

## Skills and decisions

- Use the repository skills for repeatable inbox, work-unit, integration, and release procedures. Validate any changed skill using the command in `docs/WORKFLOW.md`.
- When a material user decision is required, use a structured Plan-mode question when available. Ask one decision at a time, give a recommended option and its consequence, and do not imitate clickable controls in Markdown.

## GitHub CLI

Use `& "C:\\Program Files\\GitHub CLI\\gh.exe"` for GitHub CLI commands. Pass the explicitly authorized repository to GitHub CLI commands, verify that repository's exact commit workflow before creating a release tag, and never change a version or tag to bypass a failed release gate.
