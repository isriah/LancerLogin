# LancerLogin session handoff

Last updated: 2026-09-02 after publishing LancerLogin v0.10.2 typography improvements.

## Start the next session here

Use this prompt in a new Codex session opened on this repository:

> Read `SESSION-HANDOFF.md` completely, then read the authoritative files it links before making changes. Continue LancerLogin from the recorded state. Preserve every isolation, deployment, testing, release-note, feedback-batching, and physical-acceptance boundary. Do not update my private installation, Cloudflare resources, or Raspberry Pi unless I explicitly ask. First tell me the current release and the next manual acceptance step; then address my new request.

Repository workspace:

`C:\Users\Izz\Documents\ChatGPT\LancerLogin Workspace`

Public repository: <https://github.com/isriah/LancerLogin>

Public documentation: <https://isriah.github.io/LancerLogin/>

Latest release: <https://github.com/isriah/LancerLogin/releases/tag/v0.10.2>

## Non-negotiable boundaries

1. LancerLogin is a new standalone Apache-2.0 project. Do not modify, commit to, deploy into, migrate from, or make the product depend on the earlier FRC Attendance System repository, database, Cloudflare resources, Raspberry Pi services, credentials, or Git history.
2. The earlier source repository at `C:\Users\Izz\Desktop\FRC Attendance System` is read-only reference material. It may be inspected only to understand desired behavior and must never receive edits or commits. Never copy production names, URLs, tokens, IDs, configuration, secrets, or organization-specific data from it.
3. A user-approved coexistence test exists in the same Cloudflare account as the earlier installation, but only through isolated LancerLogin resources. Never bind, route, query, migrate, restore, rename, delete, or otherwise touch earlier resources. Never use them as a dependency.
4. Do not deploy or upgrade the adopter's private installation automatically. The user intentionally tests the private GitHub **Install or upgrade LancerLogin** workflow manually.
5. Do not modify the Pi or run real Cloudflare/GitHub deployment operations without an explicit, current user request. Local mocks, isolated local D1, read-only GitHub status checks, public source pushes, and release publication are normal development operations when the user asks for a release.
6. Never expose or persist credentials in source, notes, commands, screenshots, logs, or chat. Discover private repository/resource identifiers at operation time rather than adding them here.
7. Fingerprint templates and raw scans stay exclusively inside the R503. The application stores only local slot-to-roster-ID mappings and finger labels. No biometric synchronization exists.
8. LancerLogin remains a self-hosted single-active-kiosk release. Multi-kiosk behavior is future work; do not accidentally relax the one-active-kiosk invariant while improving lifecycle UX.
9. There is no live migration, resource connection, database migration, or biometric-template transfer path from the earlier attendance installation. Exported roster rows and local R503 slot mappings may be prepared for import with the reviewed file-based helper.

## Collaboration and development cadence

- Work autonomously through an approved batch. Do not pause merely to report progress or ask the user to say “continue.” Stop only for genuine unresolved product/security design input, missing authorization for an external mutation, or completion.
- Treat all feedback, UI observations, and feature additions as an ongoing queue by default. Record each item without implementing it, unless the user explicitly says to execute the current item or batch now. Offer a short rationale when useful, maintain a consolidated queue, and wait until the user reconciles the feedback round and explicitly authorizes bulk execution.
- Otherwise, implement requested product changes completely, using reasonable in-scope assumptions and asking only when alternatives would materially change behavior or security.
- Use focused commits with descriptive messages. Preserve unrelated user changes in a dirty worktree.
- Use `apply_patch` for source/document edits. Prefer `rg`/`rg --files` for discovery.
- Use the smallest relevant verification command after each sub-unit, then one complete gate after the batch. This is deliberate: do not repeatedly run the entire suite after every small edit.
- Keep commentary updates concise and do not leave the user without an update during long-running work.
- Every release must have meaningful user-facing patch notes, migration/security details, known limits, upgrade instructions, and manual verification steps. Patch notes must appear in both `docs/releases/vX.Y.Z.md` and the public documentation release index.
- Never claim a physical, provider, deployment, or browser result that was only mocked. Record the exact acceptance boundary.

Detailed process: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)

## Product decisions that remain authoritative

- Audience: clubs, classrooms, teams, and arts groups.
- Hardware: Raspberry Pi 3B+, 4, or 5 with at least 1 GB RAM; Waveshare 7-inch DSI LCD (E); R503; Wi-Fi or Ethernet.
- Authentication: Google OAuth, local username/password, or both. Local passwords use salted scrypt. Password recovery is the documented local setup-tool reset.
- Roles: Admin has all powers. Operator manages meetings, attendance, corrections, excuses, reports, and kiosk status, but not users/security/integrations/branding/destructive configuration. Configurable roles remain out of scope.
- Onboarding: temporary, paginated, resumable, cross-Admin, non-modal workflow covering brand, roster, pairing, kiosk input, and attendance confirmation. Steps are skippable. Completion shows an accessible celebration and returns Home. Completed setup remains reachable from settings/help.
- Branding: organization name, optional subtitle/logo, primary/secondary colors, themed/light/dark/follow-device appearances. Default LancerLogin.
- Attendance: every meeting has start and end times. A member scans on arrival and departure. Arrival alone is active but not present; a completed pair is present; a missing/incomplete pair is absent after the shared cutoff. Corrections/excuses are reasoned and audited.
- Meeting attendance windows may not overlap, including the one organization-wide late-scan allowance. The rule covers one-time creation, recurrence, occurrence/future-series edits, and changes to the shared allowance. There is no per-meeting late-scan override.
- Data persists until Admin export/deletion. Meeting deletion is a soft delete that hides active scheduling while retaining attendance/audit history. CSV and documented D1/JSON backup/restore are supported; PDF and Sheets are not.
- Optional integrations: Google OAuth, Resend attendance mail, and the Discord linking/absence/contest/calendar/persistent-status workflow. Credentials are encrypted per installation and never redisplayed. An integration is Configured only after end-to-end verification.
- Captive portals remain unsupported; normal Wi-Fi/Ethernet and offline-first queueing are supported.
- User-facing privacy language is **anonymous usage reporting**, enabled by default with a clear opt-out. The strict payload allowlist excludes roster, attendance, fingerprint/biometric, organization, credentials, and raw IP.
- Public docs are task-first and accessible, with WCAG 2.2 A as the target. Support is `robolancers@gmail.com` without an SLA.

Authoritative detail:

- [`docs/DECISIONS.md`](docs/DECISIONS.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/PRIVACY.md`](docs/PRIVACY.md)
- [`docs/COMPLETION-AUDIT.md`](docs/COMPLETION-AUDIT.md)

## Current repository and release state

- Branch: `main`
- v0.10.2 code/tag commit: `591c140295707312aa1c46e185bb8f1539e44067` (`Keep installer source unchanged for v0.10.2`)
- Immutable v0.10.2 tag commit: `591c140295707312aa1c46e185bb8f1539e44067`
- Working tree was clean at handoff.
- v0.10.2 is a published, non-draft, non-prerelease GitHub release with the guided installer, arm64/armv7 archives, and SHA-256 files.
- Latest GitHub **Verify** completed successfully on `main` for `591c140` before the v0.10.2 tag, and the v0.10.2 release workflow completed successfully.
- Local/full gate evidence for the v0.10.2 patch: `npm run verify:release` passed outside the sandbox after an esbuild sandbox filesystem-access failure. The release makes no physical Pi acceptance claim.
- GitHub Pages emitted a non-blocking warning that `actions/configure-pages@v5` currently targets deprecated Node.js 20 on the runner. Publication succeeded. Treat checking for an official successor as low-priority cleanup; verify current official action guidance before changing it.

Release notes: [`docs/releases/v0.10.2.md`](docs/releases/v0.10.2.md)

Durable feature history: [`docs/HANDOFF.md`](docs/HANDOFF.md)

Roadmap/evidence: [`docs/ROADMAP.md`](docs/ROADMAP.md) and [`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md)

## What v0.10.2 delivered

- Readability increase across the desktop dashboard, member-facing kiosk, and protected fingerprint maintenance UI.
- Dashboard now has a 17px desktop base and larger dense operational table, label, helper, and action text.
- Kiosk and maintenance panels use larger status/prompts/control text while keeping their existing 800x480 compact fallbacks.
- No Pi installer source change was made; release packaging stamps the matching immutable release version into its generated installer artifact.

## What v0.10.1 delivered

- Pi installer patch: future installs create a **LancerLogin Kiosk** desktop shortcut for the installing desktop user when Chromium is available.
- The shortcut and desktop-login autostart use the same launcher to reopen the local attendance screen in full-screen kiosk mode.
- Physical acceptance confirmed the shortcut reopened the kiosk in full-screen mode on the test Pi.

## What v0.10.0 delivered

- Dashboard meeting cleanup: removed test-meeting UI, simplified meetings to one date plus start/end times with a 2.5-hour end-time autofill, added soft deletion for an occurrence or future series occurrences, and added automatic/bulk Discord calendar sync using existing event mappings.
- Dashboard/release polish: operational cards fill available dead space more consistently and dashboard version display uses plain `0.n.n` formatting while Git tags and release-note filenames keep the existing `v0.n.n` convention.
- Physical kiosk restoration: copied the pre-community layout more closely, fixed the top-half screen issue, improved adaptive organization name/logo/subtitle placement, preserved themed logo contrast logic, and restored the hidden brand long-press for protected fingerprint maintenance.
- Maintenance UI polish: PIN-only locked screen, no normal-screen FP shortcut, touch-friendly member picker, on-screen numeric slot keypad, themed action buttons, no-scroll 800x480 target, and plain-language R503 enrollment errors.
- File-based legacy import helper: exported roster rows and local R503 slot mappings can be prepared for LancerLogin while fingerprint templates remain on the same physical sensor.

## What v0.9.0 delivered

- Non-overlapping meeting attendance windows and deterministic automatic meeting selection from each kiosk scan timestamp.
- Continuous R503 polling with an eight-second held-finger debounce.
- Full-screen 800×480 member-facing ready/processing/welcome/goodbye/unknown/rejected/reader-offline/cloud-offline states.
- Semantic R503 aura-light feedback.
- Locally cached organization branding, including adaptive transparent-logo treatment.
- Atomic ordered offline scan queue and terminal handling for expected server rejections.
- Kiosks page lifecycle outside onboarding: add/replace, rename, retire, device history, heartbeat, reader status, pending queue, last sync, installed release, and scrubbed issue category.
- PIN-protected touch Wi-Fi settings via NetworkManager, on-screen keyboard, rate limiting, and no LancerLogin password storage.
- PIN-protected on-device fingerprint maintenance: active roster labels, reader test, fixed finger labels, slot suggestions, replacement confirmation, and local mapping removal without template export.
- Four Admin-only, device-scoped, 15-minute recovery commands: reload display, restart software, reboot Pi, and reset local PIN. There is no remote shell or arbitrary command payload.
- Installer hardening: serial configuration before every start, `dialout` membership, service health verification, useful journal output, narrow Polkit rules, safe in-place upgrade, and explicit refusal to take port 8788 from another service.
- Real sanitized v0.9 kiosk documentation screenshot generated from the production UI, plus an 800×480 browser regression test.

Kiosk operating guide: [`docs/KIOSK.md`](docs/KIOSK.md)

## Deployment topology and privacy boundary

- Public `isriah/LancerLogin`: reviewed source, tags, releases, docs, and immutable Pi artifacts. It has no adopter Cloudflare secret.
- Each adopter creates a private repository from the template. That private repository contains GitHub Environment secrets and private deployment history.
- The private workflow provisions or upgrades only adopter-named Worker, D1, and Pages resources. The dashboard update page only downloads a backup and opens GitHub; it cannot dispatch the workflow.
- The isolated test installation uses a distinct LancerLogin Worker, D1 database, and Pages project alongside earlier resources in the same account. No custom domain, Worker route, DNS binding, shared database, shared secret, or migration path connects them.
- Anonymous usage collection is a separate collector-only service/account boundary and is not an adopter deployment dependency.

Provisioning detail: [`docs/BOOTSTRAPPING.md`](docs/BOOTSTRAPPING.md) and [`docs/CLOUDFLARE-LINKING.md`](docs/CLOUDFLARE-LINKING.md)

## Physical Pi status at handoff

- Dedicated device hostname observed during testing: `AttKiosk`.
- Raspberry Pi Node version observed: 20.19.2.
- The initial LancerLogin service failed with `EADDRINUSE` because the retained pre-community kiosk already owned `0.0.0.0:8788`.
- The older service was not silently deleted. Conversion work disabled conflicting old user services recoverably, and LancerLogin subsequently ran on the device.
- Manual serial configuration confirmed the R503 online with 49 templates. The v0.9 systemd unit now reapplies the required `/dev/serial0` settings before every start so this does not depend on a one-time shell command.
- v0.10 kiosk polish files were staged on the test Pi, but root installation still requires the user to run the provided `sudo install ... && sudo systemctl restart lancerlogin-kiosk.service` command locally or through an actual sudo prompt. Do not send the sudo password as an SSH command.
- Do not assume the v0.10.x release has been fully accepted on the Pi. The user must complete end-to-end acceptance after applying the staged files or running the published v0.10.1 installer.
- Do not erase R503 templates or local mappings during acceptance. Back up application data first and use a nonessential sensor slot for enrollment testing.

## Remaining work, in order

There are no known uncommitted code defects in the approved v0.10 batch. The immediate remaining work is manual acceptance:

1. In the adopter-owned private deployment repository, manually run **Install or upgrade LancerLogin** with **Upgrade** and **Latest stable**, using the existing isolated LancerLogin installation slug and exact confirmation. Download an Entire installation backup first.
2. Confirm the private workflow deploys v0.10.1 only to the isolated LancerLogin Worker/D1/Pages resources. Do not inspect or alter earlier attendance resources.
3. On the Pi, either keep the already applied staged kiosk polish plus desktop shortcut, or download the v0.10.1 installer, run `--dry-run`, then `--install`:

   ```bash
   curl -fL https://github.com/isriah/LancerLogin/releases/download/v0.10.1/install-lancerlogin.sh -o /tmp/install-lancerlogin.sh
   sudo bash /tmp/install-lancerlogin.sh --dry-run
   sudo bash /tmp/install-lancerlogin.sh --install
   ```

4. Verify the Pi retained pairing, branding, queue, local mappings, and settings PIN. If port 8788 is occupied, identify the exact owner and ask before disabling/removing anything; the installer intentionally fails closed.
5. Complete physical acceptance during a harmless test meeting:
   - meeting-overlap rejection;
   - automatic meeting resolution with no kiosk meeting selector;
   - first scan arrival/welcome and second scan departure/goodbye;
   - held-finger debounce;
   - unknown fingerprint and reader-offline feedback;
   - network disconnect, queued scan, reconnect, exactly-once delivery;
   - protected touch Wi-Fi flow;
   - reader test and enrollment in a nonessential slot;
   - dashboard health, rename, reload display, restart software, reboot, and PIN reset;
   - Operator can monitor but cannot issue Admin recovery/lifecycle actions.
6. Record pass/fail evidence in [`docs/COMPLETION-AUDIT.md`](docs/COMPLETION-AUDIT.md) and update this file after acceptance.
7. After hardware acceptance, perform the user-planned cleanup pass and provider-specific manual checks as feedback arrives.

## Explicitly deferred work

- Expanded browser kiosk simulator. The future implementation must render the exact physical kiosk screen and reuse the same state transitions and attendance behavior. Only the hardware adapter changes: a browser roster/fingerprint-event control substitutes for R503 input. Simulator events must remain clearly marked/audited and must not count as a physical active kiosk. Keep the current guided-setup simulator until replacement is accepted.
- Multi-kiosk operation and biometric synchronization. The current lifecycle/history UX may be designed with future device turnover in mind, but the runtime still permits one active physical kiosk.
- Configurable/custom roles.
- Captive-portal automation.
- PDF/Google Sheets exports.
- Migration from any earlier attendance installation.

## Feedback queue status

The current physical kiosk revision batch was implemented and applied to the test Pi during this session. The authorized dashboard/release-management follow-up was implemented locally: no test-meeting UI, same-day date/time meeting fields with 2.5-hour autofill, soft meeting deletion including future series occurrences, automatic and bulk Discord calendar sync using existing event mappings, wider operational cards, and plain `0.n.n` dashboard version display. A subsequent kiosk-polish execution removed the visible FP shortcut, restored hidden brand long-press maintenance access, enforced a PIN-only maintenance lock screen, added touch-friendly member and slot pickers, translated R503 errors into plain language, and added a file-based legacy roster/slot-mapping import helper. With explicit approval, kiosk self-update management is now implemented as a fixed Latest stable command: a unit-specific Polkit rule starts an argument-free root unit, which resolves only the official `v0.n.n` GitHub release and verifies both installer and kiosk archive checksums. The private Upgrade workflow typed confirmation was removed while retaining explicit operation selection, slug validation, resource checks, and GitHub's final dispatch button.

A new feedback collection round is open at [`docs/feedback/2026-09-01-kiosk-acceptance.md`](docs/feedback/2026-09-01-kiosk-acceptance.md). Do not implement newly provided feedback while the user is still collecting it unless they explicitly switch to execution.

Permanent project rule: feedback and feature additions are compiled first and executed in bulk only after the user reconciles a round of feedback/improvements and explicitly switches from collection to execution.

If the user begins or continues another feedback round:

1. Create or update a clearly labelled queue in this file or a new dated file under `docs/feedback/`.
2. Record the exact observation, affected page/device, expected behavior, screenshot/link if supplied, and any design dependency.
3. Do not implement while the user is still collecting feedback unless they explicitly switch to execution.
4. Before execution, summarize duplicates, conflicts, security implications, release scope, and proposed verification areas.

## Verification commands

Run the smallest relevant command while iterating:

| Area | Command |
| --- | --- |
| Worker/shared policy | `npm run verify:api` |
| Dashboard | `npm run verify:dashboard` |
| Public docs | `npm run verify:docs` |
| Pi kiosk/installer | `npm run verify:kiosk` |
| GitHub/Cloudflare provisioning | `npm run verify:provisioning` |
| Anonymous usage collector | `npm run verify:telemetry` |
| D1 migrations | `npm run verify:migrations` |
| Chromium interaction | `npm run verify:browser` |

At the end of a completed batch:

```bash
npm run verify:all
```

Before a release:

```bash
npm run verify:release
npm run verify:browser
```

On this Windows host, esbuild/Vite or Playwright may require the approved outside-sandbox execution because module traversal/browser launch can be blocked by the workspace sandbox. A sandbox-only access failure is not a passing build; rerun the same command with the required permission and report the distinction.

Release sequence:

1. Focused tests per unit.
2. Focused commit(s).
3. Full local release gate and Chromium gate.
4. Push `main`.
5. Wait for exact-commit GitHub **Verify** success, including actionlint/browser smoke.
6. Create/push the version-matching tag only after CI succeeds.
7. Wait for **Build community release** and verify all artifacts.
8. Update/publish `docs-site` if its manually maintained release index or screenshots changed.
9. Never trigger the adopter's private Upgrade workflow as part of public release publication.

## Repository map

- `apps/api`: Cloudflare Worker API and D1 migrations.
- `apps/dashboard`: Vite/React Pages dashboard.
- `apps/kiosk`: Pi service, R503 protocol, UI, local tools, installer, systemd and Polkit files.
- `apps/telemetry-collector`: isolated anonymous-usage collector.
- `packages/shared`: shared policy/domain code.
- `tests` and `tests-ts`: Node/API/security/provisioning/kiosk/docs tests.
- `tests-browser`: Chromium dashboard and 800×480 kiosk smoke tests.
- `docs`: technical decisions, handoff, release notes, audit, operations guidance.
- `docs-site`: manually maintained public GitHub Pages site and sanitized annotated assets.
- `.github/workflows/provision-template.yml`: private adopter Create/Resume/Upgrade workflow.
- `.github/workflows/ci.yml`: exact-commit release gate and browser/action linting.
- `.github/workflows/release.yml`: immutable tagged release and Pi artifact packaging.
- `.github/workflows/docs.yml`: public Pages publication.

## Before changing anything in the next session

1. Read this file completely.
2. Run `git status --short`, `git log -5 --oneline`, and inspect the current user request.
3. Read the directly relevant authoritative docs and source; do not assume this handoff supersedes newer commits.
4. Confirm whether the user is providing feedback for a future batch, asking for diagnosis only, or authorizing implementation/external operation.
5. Preserve the manual-upgrade boundary unless the user explicitly changes it.
