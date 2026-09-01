# Local development and verification

LancerLogin uses focused checks during implementation and one complete gate at the end of a batch. All commands are local and use mocks or an isolated local D1 database; they do not contact or deploy to an adopter's Cloudflare account.

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

If a change crosses areas, run each affected scope. Migration changes also require `npm run verify:migrations`.

## Completed batches

Run `npm run verify:all` once after the focused checks pass. It applies every D1 migration to a fresh isolated local database, typechecks all workspaces, runs the complete test suite, and produces all production builds.

Before creating a release tag, run `npm run verify:release`. This adds the high-severity dependency audit. Main-branch CI runs the same release gate.

The tag workflow does not repeat the full gate. It requires a successful **Verify** run on `main` for the exact tagged commit, checks the version and patch-notes file, packages the kiosk artifacts, and publishes the immutable release. A tag created before its exact commit passes CI fails closed and may be retried after verification succeeds.
