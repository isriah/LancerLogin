# Local development and verification

LancerLogin uses focused checks during implementation and one complete gate when preparing a release. All commands are local and use mocks or an isolated local D1 database; they do not contact or deploy to an adopter's Cloudflare account.

Read the guide for the surface you are changing and use its stated acceptance criteria. Keep implementation, verification, and review focused on that surface.

## During implementation

Run the smallest command that covers the files being changed:

| Area | Command | Coverage |
| --- | --- | --- |
| Worker API and shared policy | `npm run verify:api` | API JavaScript and TypeScript tests plus API/shared typechecks |
| Dashboard | `npm run verify:dashboard` | Dashboard behavior tests plus dashboard typecheck |
| Public documentation | `npm run verify:docs` | Static documentation content and accessibility assertions |
| Raspberry Pi kiosk | `npm run verify:kiosk` | Kiosk, installer, extracted release-artifact smoke tests plus kiosk typecheck |
| GitHub/Cloudflare provisioning | `npm run verify:provisioning` | Account-neutral workflow, setup, maintenance, and template checks |

For a changed browser interaction, use `npm run test:browser -- <test-file-or--grep>` during implementation and the unfiltered `npm run test:browser` after integration. The wrapper gives each worktree its own transform cache and deterministic three-port range and refuses to reuse an existing fixture server.

If a change crosses areas, run each affected scope. Migration changes also require `npm run verify:migrations`.

### Documentation changes

Classify a documentation surface as current guidance, reference, historical evidence, or generated output before changing it. Use the released interface labels, keep private installation details out of public material, and run `npm run verify:docs` after changing maintained documentation. Add focused reference, command, boundary, or asset checks when the static documentation test does not cover a meaningful risk.

Static site and Markdown changes need a rendered review at the affected desktop and mobile sizes. Check headings, keyboard focus, links, captions, alternative text, and clipped content. A simulator, source inspection, or local mock is not physical kiosk acceptance. Do not run a release gate, deployment, update, or destructive recovery command merely to verify prose.

### Dashboard visual changes

Web-update API checks use isolated real SQLite for unique-lock/audit/idempotency and retryable disk-queue replay. Provisioning checks include canonical migration hashes, official release/resource/credential guards, actual Pages identity and explicit recovery. `npm run rehearse:web-upgrade` runs an eleven-case provider-free synthetic bridge/V1/failure matrix. It is not fresh-adopter or live provider/Pi acceptance. Review compatibility-manifest ownership and secure rehearsal requirements in [WEB-UPDATES.md](WEB-UPDATES.md); workflow changes also require actionlint.

Reuse shared UI tokens and controls; verify keyboard focus, themes, desktop and mobile layouts and behavior. Do not expand a focused change into a retrofit of unrelated styling.

## Release preparation

Run `npm run verify:all` once after the focused checks pass. It applies every D1 migration to a fresh isolated local database, typechecks all workspaces, runs the complete test suite, and produces all production builds.

Before creating a release candidate commit, run `npm run verify:release`. This adds the bounded high-severity audit of every dependency recorded in `package-lock.json`. The audit may retry a transient registry, gateway, rate-limit, or network failure up to three times while staying inside a 120-second process ceiling. A vulnerability result fails immediately without retry. If this host cannot reach the advisory endpoint after all bounded attempts, the local command reports an explicit deferral instead of a false security result; the release must then wait for the strict dependency-audit job in GitHub Verify on the exact unchanged commit. That strict CI job never permits deferral, and no tag may be created until it passes.

The GitHub **Verify** workflow reports repository verification, dependency audit, browser smoke, and action lint separately. Verification and browser jobs install with `npm ci --no-audit`; security findings come from the one explicit, bounded audit job rather than duplicate implicit audits. The audit job uses Node 24's current npm client, materializes the dependency tree with lifecycle scripts and implicit auditing disabled, then runs the sole bounded audit command. It runs for dependency-manifest changes, scheduled default-branch monitoring, manual verification, and `Release vX.Y.Z` candidate commits; ordinary code-only and documentation-only changes do not wait on the external registry. A release still requires the whole exact-commit workflow to succeed.

The tag workflow does not repeat the full gate. It requires a successful **Verify** run on `main` for the exact tagged commit, checks the version and patch-notes file, packages and validates both kiosk archives with the same utility tested by `verify:kiosk` and `verify:all`, and publishes the immutable release. A tag created before its exact commit passes CI fails closed and may be retried after verification succeeds.

## Kiosk artifact verification

`node scripts/package-kiosk.mjs <new-output-directory>` builds both ARM64 and ARMv7 archives, the versioned installer, and their SHA-256 files. The output directory must not already exist. The shared packager copies every runtime `.mjs` file, then verifies checksums and extracts each archive into an operating-system temporary directory outside the checkout. A child Node process loads the extracted service and serves its real health and screen assets using isolated empty state with hardware and background polling disabled. The test suite also removes `update-command.mjs` from an extracted archive and requires startup to fail even though that file remains in the checkout.

The packager explicitly assigns `0755` to every code directory (including the archive root) and shell helper, and `0644` to runtime modules and service/policy files. POSIX validation rejects incorrect extracted modes even when the checksum is valid. The installer also restores `/opt/lancerlogin` to `0755` after extraction; `/var/lib/lancerlogin` remains private `0700` state.

Windows runs the import/HTTP tests but cannot establish Linux permission safety. GitHub Verify additionally runs `sudo "$(command -v node)" --test tests/kiosk-artifacts.test.mjs` on Linux. Its root-owned extracted artifacts must start after the child drops to the non-root `nobody` UID/GID, explicitly re-enters the runtime directory, and asserts the code belongs to a different account. State is a separate private temporary directory owned by that account. A `0700` root must actually fail with `EACCES`; the installer's repair must restore startup. The tag workflow requires `sudo "$(command -v node)" scripts/package-kiosk.mjs <new-output-directory> --require-unprivileged` on the exact archives it publishes. This option fails unless running on Linux as root and must not be removed to bypass a failed release gate.

Source-tree tests alone are insufficient evidence for kiosk releases. Keep new runtime assets in the shared packaging path and extend artifact checks when adding a new asset type, runtime subdirectory, dependency, or entry point. These checks do not establish physical UART/R503, systemd, Chromium, or installed-Pi behavior; perform the release's live checks after the separately authorized upgrade.
