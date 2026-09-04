---
name: ll-release
description: "Package merged, unreleased LancerLogin work units into one verified release on an explicitly authorized repository. Use only when the user explicitly invokes a release command; never deploy an installation."
---

# LancerLogin Release

Read `AGENTS.md`, `docs/future_work.md`, `docs/RELEASE-CHECKLIST.md`, `docs/DEVELOPMENT.md`, and `docs/releases/README.md` before acting. Read the affected product documentation where the release bundle includes a high-risk surface.

Before any mutation, resolve the explicitly authorized Git remote and GitHub repository. Verify fetch and push URLs and repository visibility, and state the boundary. Never assume `origin` or the production repository is authorized. Pass the resolved repository explicitly to GitHub CLI commands. A sandbox rehearsal uses only its sandbox remote/repository and a new never-reused prerelease version.

Interpret the requested mode from the remaining prompt text:

- **preview-unreleased**: Read-only. Identify every merged work unit not included in a published release and report the proposed bundle, release-impact evidence, migration/configuration implications, and a recommended version.
- **package-unreleased**: Package every merged work unit that is not included in a published release. The explicit invocation authorizes release preparation and publication, but never a private-installation deployment or Pi update.

Determine inclusion from both the ledger and repository history. A unit is eligible only when it is `merged`, its merge commit is reachable from `main`, it is later than the latest published release tag, and its `Release` field does not already name a published release. Report stale or conflicting ledger/history evidence instead of silently guessing.

For `package-unreleased`, first present the exact eligible bundle and proposed version. Use the structured decision framework in `AGENTS.md` for any material version or inclusion choice—for example, when a data migration or feature-level change makes a patch versus minor release ambiguous. Once the user chooses, do not ask again for that same release decision.

Then:

1. Update all included work units with the chosen release version, update every applicable package version, and create `docs/releases/vX.Y.Z.md` using the documented release-note format. The notes must state included work units, user-visible behavior, migrations, configuration/deployment implications, known limits, and manual validation.
2. Run the focused verification required by the included work, then `npm run verify:release`.
3. Inspect the final diff, commit only the intended release-preparation files with subject `Release vX.Y.Z`, and push `main` only to the authorized remote. The subject forces the selective dependency-audit job for that exact release candidate even if no dependency manifest changed.
4. Wait for the exact pushed commit's GitHub **Verify** workflow in the authorized repository to pass. Do not tag a different commit or change the version to bypass a failed gate.
5. Create and push the matching `vX.Y.Z` tag, then wait for the immutable public release build and report its URL and verification result.

Leave active, ready, blocked, or failed work units out of the bundle. Never dispatch the private Upgrade workflow, mutate Cloudflare resources, deploy an installation, or update the Pi. Report the manual private-upgrade steps separately after publication.
