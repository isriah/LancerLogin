# Community release requirement checklist

This checklist maps the approved Community Release Plan to durable implementation and verification evidence. “Implemented” means the repository is ready for mock/local verification; it does not claim a real Cloudflare deployment or physical hardware test.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Standalone LancerLogin project, Apache-2.0, clean history, no migration or legacy connection | Implemented | `LICENSE`, `docs/DECISIONS.md`, sanitizer tests in `tests/foundation.test.mjs` |
| Clubs, classrooms, teams, and arts groups; one kiosk only | Implemented | `README.md`, shared product policy, one-active-kiosk D1 constraint, replacement tests |
| Pi 3B+/4/5, at least 1 GB; Waveshare 7-inch DSI LCD (E); R503; Wi-Fi/Ethernet | Implemented in guide/installer | `docs/KIOSK.md`, installer hardware checks, 800×480 browser visual; physical acceptance pending |
| Fingerprint templates remain exclusively in the R503 | Implemented with mocked serial transport | R503 protocol, local slot mapping, schema/sanitizer tests; physical acceptance pending |
| Browser-led GitHub template and adopter-owned Cloudflare setup | Implemented without an adopter target | Manual guarded workflow verifies a scoped account-owned token against the selected account ID, recovers interrupted secret setup, creates Worker/D1/Pages, and outputs the Pages URL |
| Public source with private adopter deployment | Implemented locally | Workflow rejects public repositories, fetches an explicit public release tag, keeps Cloudflare/setup secrets in a private environment, and exposes the private updater URL only to authenticated Admins |
| Guided Pi setup without clone or manual source edits; short-lived one-time pairing | Implemented | Dashboard installer link, version-matched checksummed installer, hashed ten-minute code, owner-only kiosk credential |
| Local, Google, or both authentication modes | Implemented | JSON/CORS-protected first-Admin bootstrap, salted scrypt, OAuth state/claim validation, encrypted Google secret, local recovery tool, Google-only lockout guard |
| Fixed Admin and Operator roles | Implemented | Worker route authorization, active-user/current-role revalidation, dashboard policy, and permission tests |
| Resumable cross-Admin guided setup | Implemented | One task per page: organization/brand, test meeting, roster, hardware or simulator pairing, kiosk input test, attendance confirmation; steps skip/reopen and completion presents an accessible celebration before Home |
| Organization branding and light/dark/themed modes | Implemented | D1-backed name, subtitle, bounded local logo data, explicit organization-colors mode, light/dark/device modes, browser interaction |
| Retention, CSV, deletion, and D1 backup/restore | Implemented | Separate meetings/attendance, roster, and installation backup/restore/delete controls; onboarding-only reset; authenticated formula-safe CSV; `docs/BACKUP-RESTORE.md`; no PDF or Sheets |
| Google, Resend, and full Discord administration/workflows | Implemented with mocked providers | Encrypted status/save/test/rotate/remove, attendance mail, linking, missing-member notices/contests, calendar mapping, heartbeat-driven persistent kiosk status with scheduled offline reconciliation |
| Manual captive-portal handling and offline-first queue | Implemented/documented | Atomic local queue, retained heartbeat/reader/release health, and task-oriented kiosk guide; advanced captive-portal compatibility remains unsupported |
| Opt-out anonymous usage reporting and plain privacy notice | Runtime, collector, governance, and fresh endpoint active | Default-enabled first-Admin checkbox with immediate opt-out; limited anonymous fields, isolated HMAC collector, retention and deletion controls |
| Hardware-free browser simulator | Implemented | Admin-only simulator code, no production kiosk token/count, test-meeting-only check-ins, online/offline controls, visible test labels, and audit events |
| Routed dashboard, roster access, and safe update assistance | Implemented locally | Deep-link pages with SPA fallback; roster-linked or non-rostered Admin/Operator accounts; version check and pre-update backup before opening GitHub; dashboard cannot dispatch deployments |
| Accessible task-first public documentation with annotated visuals | Published | Dashboard, GitHub, Cloudflare, OAuth, kiosk, and integrations visuals; WCAG 2.2 A target; `https://isriah.github.io/LancerLogin/` |
| Community support without SLA | Implemented | `robolancers@gmail.com` is documented with explicit no-SLA language |

## Verification boundary

Automated tests use fake D1 bindings, provider responses, Cloudflare resource lists, and R503 transport. The dedicated community collector workflow passed its live self-tests. The adopter provisioning workflow also created only the user-approved isolated `lancerlogin-test` Worker, D1, and Pages resources alongside—but without connecting to or modifying—the earlier attendance resources. Provider delivery, Pi installation, and physical sensor operation remain untested.

The v0.4 private-deployment release has not yet been deployed. Its fresh private-repository Create run is deliberately reserved for live acceptance after the release tag is published.

The detailed requirement-to-evidence matrix is maintained in `docs/COMPLETION-AUDIT.md`.

Both `.github/workflows/ci.yml` and `.github/workflows/release.yml` run the account-neutral `verify:migrations` gate against a fresh local D1 database before accepting a commit or tag.
