# Local development and verification

LancerLogin uses focused checks during implementation and one complete gate when preparing a release. All commands are local and use mocks or an isolated local D1 database; they do not contact or deploy to an adopter's Cloudflare account.


## Hosted D1 development budget

Use local SQLite/Miniflare and synthetic provider transports for implementation, regressions, large fixtures and interruption drills. Local test counts do not consume hosted D1 allowance. Hosted acceptance is a separate, deliberately scheduled gate; do not point a general test suite at the development deployment.

D1's Free daily allowance counts rows read and rows written across the account, not just query count. Use Cloudflare analytics metadata to attribute consumption before running diagnostic SQL. At75%or greater of either daily allowance, defer optional hosted D1 checks and continue local work. Necessary already-authorized preservation/reconciliation is separate; never repeat an uncertain mutation merely because testing is paused. Avoid repeated quota polling, full exports and table scans. Plan each later hosted batch around one concrete acceptance outcome, expected row cost and a stopping budget, then read analytics once before/after the batch.

Close task-owned hosted test pages when their acceptance work ends. Avoid unattended browser polling and background fixture schedules; changing deployed schedules still needs explicit authorization. Audit local query plans/indexes and polling cadence before deployment. Do not add blanket caching that bypasses current authorization or stale-state checks. Account-wide growth can come from other databases; production changes require separate authority.

On September11, metadata-only attribution found approximately4.03million reads in frc-attendance versus31,432 in modular-development. The current updater implementation tests made no hosted D1 calls. This historical measurement is not a current quota reading. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

## Recovery verification runtime

Use current **Node 24 LTS, at least 24.10.0**, for complete repository verification and the development application-recovery experiment. Node added [`DatabaseSync.setAuthorizer`](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html#databasesetauthorizercallback) in 24.10.0. The recovery model uses that API and its authorization constants to reject unsafe export SQL; Node 22 cannot run this security check. The model fails immediately with an actionable prerequisite error when the version or capability is missing. Recovery never falls back to parsing SQL without the authorizer, and its tests are not skipped.

The CI `verify` job selects the maintained Node 24 line, including recovery tests through the existing full test glob. This development prerequisite does not change the Pi, Worker runtime or browser-smoke job. Newer major Node versions are not the CI reference even if they expose the required API. Run `node --test tests/application-recovery-runtime.test.mjs tests/application-recovery-spike.test.mjs` for focused runtime and recovery validation. Dependencies: WU-113/116 recovery model and checkpoint protocol.

## During implementation

Run the smallest command that covers the files being changed:

| Area | Command | Coverage |
| --- | --- | --- |
| Worker API and shared policy | `npm run verify:api` | API JavaScript and TypeScript tests plus API/shared typechecks |
| Dashboard | `npm run verify:dashboard` | Dashboard behavior tests plus dashboard typecheck |
| Public documentation | `npm run verify:docs` | Static documentation content and accessibility assertions |
| Raspberry Pi kiosk | `npm run verify:kiosk` | Kiosk, installer, and release-package assertions plus kiosk typecheck |
| GitHub/Cloudflare provisioning | `npm run verify:provisioning` | Account-neutral workflow, setup, maintenance, and template checks |

For a changed browser interaction, use `npm run test:browser -- <test-file-or--grep>` during implementation and the unfiltered `npm run test:browser` after integration. The wrapper gives each worktree its own transform cache and deterministic three-port range and refuses to reuse an existing fixture server.

If a change crosses areas, run each affected scope. Migration changes also require `npm run verify:migrations`.

### Dashboard visual changes


## Release preparation

`npm run verify:kiosk` includes packaging both arm64 and armv7 archives with the
shared `scripts/package-kiosk.mjs` packager and starting their extracted runtime
without checkout imports. Regressions cover missing direct/transitive modules,
valid-checksum incomplete archives, missing checksums and unsafe POSIX modes.
The Linux Verify job additionally runs the artifact tests as root and starts
root-owned extracted code as `nobody`, proving a separate service identity can
traverse it. Windows skips the POSIX mode and distinct-account tests; local
Windows success does not establish those gates or physical Pi acceptance.

`tests/kiosk-release.test.mjs` verifies the fixed Pi updater's compatible release
selection with synthetic HTTP responses, including deadlines, malformed feeds and
missing installer assets. Its Linux-only shell fixture verifies fixed download URLs,
checksum rejection, selected-version forwarding and recovery restart without
running an actual installer or systemd. Windows skips that shell test; Linux CI must
establish it. Dependencies: WU-123 compatible API selection and WU-122 artifacts.

Imported from original repository commits `5114238` and `944abf5` for WU-122.
Dependencies: existing kiosk service and installer. Release packaging remains
only in `.github/disabled-workflows/release.yml`, with its explicit false guard;
this development repository does not publish community releases.

Run `npm run verify:all` once after the focused checks pass. It applies every D1 migration to a fresh isolated local database, typechecks all workspaces, runs the complete test suite, and produces all production builds.

Before creating a release candidate commit, run `npm run verify:release`. This adds the bounded high-severity audit of every dependency recorded in `package-lock.json`. The audit may retry a transient registry, gateway, rate-limit, or network failure up to three times while staying inside a 120-second process ceiling. A vulnerability result fails immediately without retry. If this host cannot reach the advisory endpoint after all bounded attempts, the local command reports an explicit deferral instead of a false security result; the release must then wait for the strict dependency-audit job in GitHub Verify on the exact unchanged commit. That strict CI job never permits deferral, and no tag may be created until it passes.

The GitHub **Verify** workflow reports repository verification, dependency audit, browser smoke, and action lint separately. Verification and browser jobs install with `npm ci --no-audit`; security findings come from the one explicit, bounded audit job rather than duplicate implicit audits. The audit job uses Node 24's current npm client, materializes the dependency tree with lifecycle scripts and implicit auditing disabled, then runs the sole bounded audit command. It runs for dependency-manifest changes, scheduled default-branch monitoring, manual verification, and `Release vX.Y.Z` candidate commits; ordinary code-only and documentation-only changes do not wait on the external registry. A release still requires the whole exact-commit workflow to succeed.

The tag workflow does not repeat the full gate. It requires a successful **Verify** run on `main` for the exact tagged commit, checks the version and patch-notes file, packages the kiosk artifacts, and publishes the immutable release. A tag created before its exact commit passes CI fails closed and may be retried after verification succeeds.

## Browser CI apt preparation

The ephemeral GitHub-hosted Ubuntu browser job comments out only the exact
`https://dl.google.com/linux/chrome-stable/deb` stable/main apt entry before
installing Playwright dependencies. Repeated development CI runs failed on that
unrelated index's checksum before any browser test started. The dashboard tests
use [Playwright's bundled Chromium](https://playwright.dev/docs/browsers), not the
runner's separately installed Google Chrome. Runner image source arrangements
can change; see the [official Chrome installer](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-google-chrome.sh).

The helper refuses other hosts, symlinks, oversized files and unfamiliar matching
entries or formats. Both legacy `.list` entries and deb822 `.sources` stanzas are
supported. For deb822, only a sole exact Chrome URI with `Types: deb`,
`Suites: stable` and `Components: main` is disabled using
[`Enabled: no`](https://manpages.debian.org/unstable/apt/sources.list.5.en.html).
Mixed-source stanzas fail closed; signing options and unrelated stanzas are
preserved. Missing Chrome entries are a no-op. Ubuntu and other package
sources, apt checksum/signature verification, all browser dependencies and the
unfiltered browser suite remain enabled. This is not a local workstation or Pi
setup step. Run `node --test tests/browser-ci-apt.test.mjs` for local fixture and
workflow checks; only a successful hosted browser job proves apt installation
and browser execution on the actual runner. Dependencies: existing browser CI.

## Development toolchain security override

The root pins the existing Wrangler `4.127.1` toolchain and overrides only
`miniflare@5.20260828.0-alpha`'s `sharp` dependency to `0.35.4`.
[GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
affects earlier sharp releases; the patch supplies the corrected libheif decoder.
At verification on 2026-09-09, even Wrangler `4.130.0` / Miniflare
`5.20260908.0-alpha` still declared sharp `0.35.2`, so upgrading Wrangler alone
would not fix the advisory. The override retains the existing workerd runtime.

Wrangler is explicit at the root because root scripts invoke it directly and npm
11.11 did not apply the root override through workspace-only Wrangler dependencies.
The lock updates only sharp and its platform binaries. Remove this temporary
version-specific override when a reviewed upstream toolchain supplies a patched
sharp; check `npm ls sharp miniflare wrangler` for vulnerable duplicates.

Verify dependency changes with `npm ci --no-audit`, `npm run audit:release`,
`node --test tests/toolchain-runtime.test.mjs`, `npm run verify:migrations`,
`npm run build`, and the unfiltered `npm run test:browser`. The native test resolves
sharp from Miniflare and decodes/resizes an in-memory synthetic AVIF. This provides
local compatibility evidence, not proof against every malicious image or a
Cloudflare deployment test. The strict audit remains the security gate for the
complete lock, including all recorded platform packages.
