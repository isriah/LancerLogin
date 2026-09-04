# Local development and verification

LancerLogin uses focused checks during implementation and one complete gate when preparing a release. All commands are local and use mocks or an isolated local D1 database; they do not contact or deploy to an adopter's Cloudflare account.

Planned development is organized as independently selectable work units in `docs/future_work.md`. A task implements a user-selected unit, using its listed documentation and acceptance criteria. Dated files in `docs/feedback/` preserve raw observations and supporting evidence; they are not the execution backlog.

## During implementation

Run the smallest command that covers the files being changed:

| Area | Command | Coverage |
| --- | --- | --- |
| Worker API and shared policy | `npm run verify:api` | API JavaScript and TypeScript tests plus API/shared typechecks |
| Dashboard | `npm run verify:dashboard` | Dashboard behavior tests plus dashboard typecheck |
| Public documentation | `npm run verify:docs` | Static documentation content and accessibility assertions |
| Raspberry Pi kiosk | `npm run verify:kiosk` | Kiosk, installer, and release-package assertions plus kiosk typecheck |
| GitHub/Cloudflare provisioning | `npm run verify:provisioning` | Account-neutral workflow, setup, maintenance, and template checks |
| Anonymous usage collector | `npm run verify:telemetry` | Collector configuration/runtime tests plus collector typecheck |

For a changed browser interaction, use `npm run test:browser -- <test-file-or--grep>` during implementation and the unfiltered `npm run test:browser` after integration. The wrapper gives each worktree its own transform cache and deterministic three-port range and refuses to reuse an existing fixture server.

If a change crosses areas, run each affected scope. Migration changes also require `npm run verify:migrations`.

## Release preparation

Run `npm run verify:all` once after the focused checks pass. It applies every D1 migration to a fresh isolated local database, typechecks all workspaces, runs the complete test suite, and produces all production builds.

Before creating a release candidate commit, run `npm run verify:release`. This adds the bounded high-severity audit of every dependency recorded in `package-lock.json`. The audit may retry a transient registry, gateway, rate-limit, or network failure up to three times while staying inside a 120-second process ceiling. A vulnerability result fails immediately without retry. If this host cannot reach the advisory endpoint after all bounded attempts, the local command reports an explicit deferral instead of a false security result; the release must then wait for the strict dependency-audit job in GitHub Verify on the exact unchanged commit. That strict CI job never permits deferral, and no tag may be created until it passes.

The GitHub **Verify** workflow reports repository verification, dependency audit, browser smoke, and action lint separately. Verification and browser jobs install with `npm ci --no-audit`; security findings come from the one explicit, bounded audit job rather than duplicate implicit audits. The audit job uses Node 24's current npm client, materializes the dependency tree with lifecycle scripts and implicit auditing disabled, then runs the sole bounded audit command. It runs for dependency-manifest changes, scheduled default-branch monitoring, manual verification, and `Release vX.Y.Z` candidate commits; ordinary code-only and documentation-only changes do not wait on the external registry. A release still requires the whole exact-commit workflow to succeed.

The tag workflow does not repeat the full gate. It requires a successful **Verify** run on `main` for the exact tagged commit, checks the version and patch-notes file, packages the kiosk artifacts, and publishes the immutable release. A tag created before its exact commit passes CI fails closed and may be retried after verification succeeds.
