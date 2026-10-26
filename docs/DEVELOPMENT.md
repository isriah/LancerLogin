# Local development and verification

LancerLogin uses focused checks during implementation and one complete gate when preparing a release. All commands are local and use mocks or an isolated local D1 database; they do not contact or deploy to an adopter's Cloudflare account.

Read the guide for the surface you are changing and use its stated acceptance criteria. Keep implementation, verification, and review focused on that surface.

Use Node.js 24.21.0, matching the verification workflow, and install dependencies with `npm ci --no-audit`. This runtime includes the [Windows shutdown fix](https://github.com/nodejs/node/pull/61999) needed for reliable Wrangler CLI checks. Older Node 24 builds can crash after the CLI correctly rejects invalid configuration; keep the test's exit-code and error assertions intact.

The lockfile uses Vite 7.3.7 and overrides Miniflare's Undici dependency to 7.30.1 for the October 2026 security fixes ([Vite advisory](https://github.com/advisories/GHSA-rq7h-c2jc-7f22), [Undici advisory](https://github.com/advisories/GHSA-4qv8-2p9j-2685)). Keep the override until the pinned Miniflare dependency itself selects a patched version, then remove it with a strict audit and affected local-runtime tests. Do not broadly refresh Wrangler or unrelated dependencies to clear an audit finding.

## During implementation

For a new bundled module, follow [module authoring](MODULE-AUTHORING.md) for registration, authorization, setup, jobs, persistence, backup and lifecycle requirements.

Run the smallest command that covers the files being changed:

| Area | Command | Coverage |
| --- | --- | --- |
| Worker API and shared policy | `npm run verify:api` | API JavaScript and TypeScript tests plus API/shared typechecks |
| Dashboard | `npm run verify:dashboard` | Dashboard behavior tests plus dashboard typecheck |
| Public documentation | `npm run verify:docs` | Static documentation content and accessibility assertions |
| Raspberry Pi kiosk | `npm run verify:kiosk` | Kiosk, installer, extracted release-artifact smoke tests plus kiosk typecheck |
| GitHub/Cloudflare provisioning | `npm run verify:provisioning` | Account-neutral workflow, setup, maintenance, and template checks |

For a changed browser interaction, use `npm run test:browser -- <test-file-or--grep>` during implementation and private acceptance. Run the unfiltered suite locally only when the change affects the whole browser application or a fresh manual preflight is explicitly needed. The exact public release commit runs the unfiltered suite in CI. The wrapper gives each worktree its own transform cache and deterministic three-port range and refuses to reuse an existing fixture server.

Optional modules have checked-in verification manifests under `module-tests/`. Use `npm run verify:module -- list` to inspect every declared selection, `npm run verify:module -- fast <module-id>` for the under-one-minute logic loop, and `npm run verify:module -- acceptance <module-id>` for the ordinary module gate with relevant API, contract, browser, typecheck, and build coverage. The bundled IDs are `attendance`, `hour-tracking`, and `carpool`. The runner fails on unknown modules, missing files or workspaces, invalid fast-mode work, and empty selections. Use direct `node scripts/run-browser-tests.mjs <files>` selection when diagnosing a browser failure. Shared contract changes still require the affected existing consumers, and the full product gate retains discovery of every test.

If a change crosses areas, run each affected scope. Migration changes also require `npm run verify:migrations`. That command verifies the complete fresh schema and rehearses a synthetic Community database from migration `0038_page_walkthroughs.sql` through the current append-only chain. The rehearsal checks preserved data, settings, reports, walkthroughs, provider grants, and legacy kiosk queue state without contacting providers or a physical Pi.

### Web development gate

Minor development changes and private checkpoints need only the affected checks above, plus focused browser coverage for changed interactions. A dashboard style, report, integration or documentation change does not require physical kiosk testing unless it affects kiosk behavior or a shared contract.

For a combined web candidate, use `npm run verify:dev`. It validates local migrations, typechecks the API, dashboard and shared package, runs all JavaScript and TypeScript tests except `tests/kiosk-runtime.test.mjs` and `tests/kiosk-artifacts.test.mjs`, builds the API/dashboard and validates templates. API pairing, attendance, security, simulator and recovery coverage remains included. It does not run browser tests; select the relevant browser files separately. Preview the test selection with `npm run test:web -- --list`.

Run `npm run verify:kiosk` as well when changing kiosk runtime, installation, packaging, kiosk dependencies or contracts consumed by the kiosk, including pairing, scan delivery, offline queues and maintenance responses. Assess shared code and dependency changes for their consumers. The web gate selects a fixed scope, not an automatic changed-file analysis.

Before publication, retain the affected private checks and compare the exported product content with the accepted source. Do not repeat `verify:release` or the unfiltered browser suite solely because an unchanged candidate was exported. The exact public trusted-branch commit whose message starts with `Release v` runs the one complete release gate, including all source tests, the unfiltered browser suite, strict audit and Linux kiosk artifact checks.

### Documentation changes

Classify a documentation surface as current guidance, reference, historical evidence, or generated output before changing it. Use the released interface labels, keep private installation details out of public material, and run `npm run verify:docs` after changing maintained documentation. Add focused reference, command, boundary, or asset checks when the static documentation test does not cover a meaningful risk.

Static site and Markdown changes need a rendered review at the affected desktop and mobile sizes. Check headings, keyboard focus, links, captions, alternative text, and clipped content. A simulator, source inspection, or local mock is not physical kiosk acceptance. Do not run a release gate, deployment, update, or destructive recovery command merely to verify prose.

### Dashboard visual changes

Web-update API checks use isolated real SQLite for unique-lock/audit/idempotency and retryable disk-queue replay. Provisioning checks include canonical migration hashes, official release/resource/credential guards, actual Pages identity and explicit recovery. `npm run rehearse:web-upgrade` runs an eleven-case provider-free synthetic bridge/V1/failure matrix. It is not fresh-adopter or live provider/Pi acceptance. Review compatibility-manifest ownership and secure rehearsal requirements in [WEB-UPDATES.md](WEB-UPDATES.md); workflow changes also require actionlint.

Reuse shared UI tokens and controls; verify keyboard focus, themes, desktop and mobile layouts and behavior. For each new panel, enumerate its action buttons and file chooser, use the shared `ui-button` roles or an established scoped control, and add focused browser assertions for the rendered styles in light and dark themes. Include controls revealed by previews or role changes. Do not expand a focused change into a retrofit of unrelated styling.

## Release preparation

Use the affected verification commands, focused browser files and product review to accept the private candidate. `npm run verify:all` and `npm run verify:release` remain available for an explicitly requested local preflight, but routine release preparation does not rerun them after equivalent scoped evidence has passed.

The GitHub **Verify** workflow uses two scopes. Pull requests and ordinary `main` or `modular` pushes run `verify:dev`, adding `verify:kiosk` only when kiosk code, packaging, shared contracts or root dependencies changed. A manual run and an exact trusted-branch commit whose message starts with `Release v` run the complete release gate. `verify:release-ci` executes migration verification, every workspace typecheck and build, all web tests and the kiosk runtime suite. The root-owned Linux kiosk artifact test runs separately so it is not repeated inside that command.

The complete gate runs the unfiltered browser suite across six CI jobs; the `browser-smoke` check passes only when every shard passes. Each shard restores the Playwright browser from a cache keyed to the locked Playwright version and installs only the system dependencies on a cache hit. GitHub shares caches only from the default branch, so the separate **Keep Playwright browser cached** workflow refreshes that cache on the default branch twice a week; it is not part of Verify and adds no required release job. The test step has its own 15-minute limit inside a 30-minute job, so slow runner setup cannot cancel tests that are still passing. It also runs the strict dependency audit. Verification and browser jobs install with `npm ci --no-audit`; security findings come from the one explicit audit job rather than duplicate implicit audits. Dependency-manifest changes and scheduled monitoring can still run that audit before a release. No tag may be created until the exact public release commit's complete Verify run passes.

The tag workflow does not repeat the full gate. It requires all ten successful **Verify** jobs for the exact tagged commit, from either a push to the selected trusted source branch or a maintainer-dispatched run on that same commit. A dispatched run counts only after the commit is confirmed to be on the trusted branch; it runs that commit's own workflow, so the release does not need a second identical run after the branch is fast-forwarded. The tag workflow also checks the version and patch-notes file, and packages both kiosk archives with the same utility tested by `verify:kiosk` and `verify:all`. It uploads a source-bound release bundle and publishes nothing. A manual run from `main` can package an existing verified tag without moving it.

A maintainer runs `node scripts/release-publication.mjs publish TAG RUN_ID` from the reviewed publication-tools checkout to check the bundle, then adds `--publish` to explicitly assemble and publish the immutable release. The command uses the existing GitHub CLI login, independently rechecks full CI, the tag, bundle digest, six asset hashes, notes, immutability and Latest policy, and never replaces a published release. The immutability preflight needs Administration-read access, which the built-in Actions token cannot provide. Do not store an extra credential in Actions or remove the preflight. See [update tracks](UPDATE-TRACKS.md).

## Kiosk artifact verification

`node scripts/package-kiosk.mjs <new-output-directory>` builds both ARM64 and ARMv7 archives, the versioned installer, and their SHA-256 files. The output directory must not already exist. The shared packager copies every runtime `.mjs` file, then verifies checksums and extracts each archive into an operating-system temporary directory outside the checkout. A child Node process loads the extracted service and serves its real health and screen assets using isolated empty state with hardware and background polling disabled. The test suite also removes `update-command.mjs` from an extracted archive and requires startup to fail even though that file remains in the checkout.

The packager writes portable ustar archives with explicit header modes: `0755` for every code directory (including the archive root) and shell helper, and `0644` for runtime modules and service/policy files. Every host validates these archive modes before extraction, even when the checksum is valid. POSIX hosts additionally validate the extracted modes. The installer normalizes the code tree before and after extraction, rejects unexpected links, and leaves `/var/lib/lancerlogin` as private `0700` state. The same checks apply to fresh installs and the official update helper's installer path.

Windows runs the import/HTTP tests but cannot establish Linux permission safety. The complete GitHub Verify gate additionally runs `sudo "$(command -v node)" --test tests/kiosk-artifacts.test.mjs` on Linux. Its root-owned extracted artifacts must start after the child drops to the non-root `nobody` UID/GID, explicitly re-enters the runtime directory, and asserts the code belongs to a different account. State is a separate private temporary directory owned by that account. A `0700` root must actually fail with `EACCES`; the installer's repair must restore startup. The tag workflow requires `sudo "$(command -v node)" scripts/package-kiosk.mjs <new-output-directory> --require-unprivileged` on the exact archives it publishes. This option fails unless running on Linux as root and must not be removed to bypass a failed release gate.

Source-tree tests alone are insufficient evidence for kiosk releases. Keep new runtime assets in the shared packaging path and extend artifact checks when adding a new asset type, runtime subdirectory, dependency, or entry point. These checks do not establish physical UART/R503, systemd, Chromium, or installed-Pi behavior; perform the release's live checks after the separately authorized upgrade.
