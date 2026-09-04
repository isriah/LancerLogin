# Community release requirement checklist

This checklist maps the approved Community Release Plan to durable implementation and verification evidence. “Implemented” means the repository is ready for mock/local verification; it does not claim a real Cloudflare deployment or physical hardware test.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Standalone LancerLogin project, Apache-2.0, clean history, no live legacy connection | Implemented | `LICENSE`, `docs/DECISIONS.md`, sanitizer tests in `tests/foundation.test.mjs`; exported roster/slot-mapping preparation is file-based and biometric-free |
| Clubs, classrooms, teams, and arts groups; one kiosk only | Implemented | `README.md`, shared product policy, one-active-kiosk D1 constraint, replacement tests |
| Pi 3B+/4/5, at least 1 GB; Waveshare 7-inch DSI LCD (E); R503; Wi-Fi/Ethernet | Implemented in guide/installer | `docs/KIOSK.md`, installer hardware checks, 800×480 browser visual; physical acceptance pending |
| Fingerprint templates remain exclusively in the R503 | Implemented with mocked serial transport | R503 protocol, local slot mapping, schema/sanitizer tests; physical acceptance pending |
| Browser-led GitHub template and adopter-owned Cloudflare setup | Implemented without an adopter target | Manual guarded workflow verifies a scoped account-owned token against the selected account ID, recovers interrupted secret setup, creates Worker/D1/Pages, and outputs the Pages URL |
| Public source with private adopter deployment | Implemented locally | Workflow rejects public repositories, fetches an explicit public release tag, keeps Cloudflare/setup secrets in a private environment, and exposes the private updater URL only to authenticated Admins |
| Guided Pi setup without clone or manual source edits; short-lived one-time pairing | Implemented | Dashboard installer link, version-matched checksummed installer, hashed ten-minute code, owner-only kiosk credential |
| Local, Google, or both authentication modes | Implemented | JSON/CORS-protected first-Admin bootstrap, salted scrypt, OAuth state/claim validation, encrypted Google secret, local recovery tool, Google-only lockout guard |
| Fixed Admin and Operator roles | Implemented | Worker route authorization, active-user/current-role revalidation, dashboard policy, and permission tests |
| Resumable cross-Admin guided setup | Implemented | One task per page: organization/brand, roster, hardware or simulator pairing, kiosk input test, attendance confirmation; steps skip/reopen and completion presents an accessible celebration before Home |
| Organization branding and light/dark/themed modes | Implemented | D1-backed name, subtitle, bounded local logo data, explicit organization-colors mode, light/dark/device modes, browser interaction |
| Retention, CSV, deletion, and D1 backup/restore | Implemented | Separate meetings/attendance, roster, and installation backup/restore/delete controls; onboarding-only reset; authenticated formula-safe CSV; `docs/BACKUP-RESTORE.md`; no PDF or Sheets |
| Google, Resend, and full Discord administration/workflows | Implemented with mocked providers | Encrypted three-state save/verify/rotate/remove; active-Admin Google callback; expiring hashed Resend code; signed Discord server/channel proof; operational workflows reject unverified credentials |
| Manual captive-portal handling and offline-first queue | Implemented/documented | Atomic local queue, retained heartbeat/reader/release health, and task-oriented kiosk guide; advanced captive-portal compatibility remains unsupported |
| Opt-out anonymous usage reporting and plain privacy notice | Runtime, collector, governance, and fresh endpoint active | Default-enabled first-Admin checkbox with immediate opt-out; limited anonymous fields, isolated HMAC collector, retention and deletion controls |
| Hardware-free browser simulator | Implemented | Admin-only simulator code, no production kiosk token/count, active-meeting check-ins, online/offline controls, and audit events |
| Complete attendance lifecycle and closing policy | Implemented | Required meeting end; arrival then departure; active/present/absent derivation; one organization-wide late-scan setting; legacy attendance preservation migration |
| Operations Home and Kiosks navigation | Implemented | Rolling last/current/next-three-week calendar, live roster, open contest review, top-level Kiosks status and simulator entry |
| Signed Discord absence contests | Implemented with mocked provider | Five-minute post-cutoff processing, durable delivery/recipient state, Ed25519 verification, recipient/message/link checks, reasoned audited resolution |
| Meaningful release patch notes | Implemented | Every tag must have `docs/releases/<tag>.md`; tagged release publishes that file and public docs link the release history |
| Routed dashboard, roster access, and safe update assistance | Implemented locally | Deep-link pages with SPA fallback; roster-linked or non-rostered Admin/Operator accounts; version check and pre-update backup before opening GitHub; dashboard cannot dispatch deployments |
| Recurring scheduling and preview-first roster import | Implemented locally | Daily/weekly/biweekly/monthly local-time series, searchable complete meeting table, occurrence/future edits, merge/replace preview, and credential/history preservation |
| Deterministic unattended physical kiosk | Implemented locally | Non-overlap validation, automatic scan-time meeting resolution, continuous R503 polling, protected local tools, lifecycle/recovery dashboard, fixed command allowlist, and hardened installer |
| In-dashboard integration setup guidance | Implemented locally | Official provider links, installation-specific callbacks, one-copy/one-paste field order, real verification, and rotation instructions inside collapsible Google OAuth, Resend, and Discord cards |
| Accessible task-first public documentation with annotated visuals | Published | Dashboard, GitHub, Cloudflare, OAuth, kiosk, and integrations visuals; WCAG 2.2 A target; `https://isriah.github.io/LancerLogin/` |
| Community support without SLA | Implemented | `robolancers@gmail.com` is documented with explicit no-SLA language |

## Verification boundary

Automated tests use fake D1 bindings, provider responses, Cloudflare resource lists, and R503 transport. The dedicated community collector workflow passed its live self-tests. The adopter provisioning workflow also created only the user-approved isolated `lancerlogin-test` Worker, D1, and Pages resources alongside—but without connecting to or modifying—the earlier attendance resources. Provider delivery, Pi installation, and physical sensor operation remain untested.

The isolated private deployment has been manually upgraded through v0.8.0. The v0.9.0 Upgrade and matching Pi installer remain deliberately reserved for user-led live acceptance after the release tag is published.

The detailed requirement-to-evidence matrix is maintained in `docs/COMPLETION-AUDIT.md`.

Local release preparation runs the complete repository gate and a bounded dependency audit, including the account-neutral migration chain against a fresh local D1 database. If this host cannot reach npm's advisory endpoint, only that transport result may be deferred; an actual vulnerability result still fails immediately. Main-branch CI runs a strict dependency audit with no deferral. The tag workflow requires a successful **Verify** run on `main` for the exact tagged commit before packaging; it does not repeat the same tests a second time. See `docs/DEVELOPMENT.md` for the focused local commands used during implementation.
