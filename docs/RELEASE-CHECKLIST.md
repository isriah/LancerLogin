# Community release requirement checklist

This checklist maps the approved Community Release Plan to durable implementation and verification evidence. “Implemented” means the repository is ready for mock/local verification; it does not claim a real Cloudflare deployment or physical hardware test.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Standalone LancerLogin project, Apache-2.0, clean history, no migration or legacy connection | Implemented | `LICENSE`, `docs/DECISIONS.md`, sanitizer tests in `tests/foundation.test.mjs` |
| Clubs, classrooms, teams, and arts groups; one kiosk only | Implemented | `README.md`, shared product policy, one-active-kiosk D1 constraint, replacement tests |
| Pi 3B+/4/5, at least 1 GB; Waveshare 7-inch DSI LCD (E); R503; Wi-Fi/Ethernet | Implemented in guide/installer | `docs/KIOSK.md`, installer hardware checks, 800×480 browser visual; physical acceptance pending |
| Fingerprint templates remain exclusively in the R503 | Implemented with mocked serial transport | R503 protocol, local slot mapping, schema/sanitizer tests; physical acceptance pending |
| Browser-led GitHub template and adopter-owned Cloudflare setup | Implemented without an adopter target | Manual guarded workflow verifies a scoped account-owned token against the selected account ID, recovers interrupted secret setup, creates Worker/D1/Pages, and outputs the Pages URL |
| Guided Pi setup without clone or manual source edits; short-lived one-time pairing | Implemented | Dashboard installer link, version-matched checksummed installer, hashed ten-minute code, owner-only kiosk credential |
| Local, Google, or both authentication modes | Implemented | JSON/CORS-protected first-Admin bootstrap, salted scrypt, OAuth state/claim validation, encrypted Google secret, local recovery tool, Google-only lockout guard |
| Fixed Admin and Operator roles | Implemented | Worker route authorization, active-user/current-role revalidation, dashboard policy, and permission tests |
| Resumable cross-Admin non-modal setup checklist | Implemented | Persisted setup progress for branding, roster, pairing, fingerprint test, test meeting, and attendance confirmation; complete state hides and can reopen |
| Organization branding and light/dark/themed modes | Implemented | D1-backed name, subtitle, bounded local logo data, explicit organization-colors mode, light/dark/device modes, browser interaction |
| Retention, CSV, deletion, and D1 backup/restore | Implemented | Authenticated and formula-safe CSV, typed-confirmation Admin deletion, `docs/BACKUP-RESTORE.md`; no PDF or Sheets |
| Google, Resend, and full Discord administration/workflows | Implemented with mocked providers | Encrypted status/save/test/rotate/remove, attendance mail, linking, missing-member notices/contests, calendar mapping, heartbeat-driven persistent kiosk status with scheduled offline reconciliation |
| Manual captive-portal handling and offline-first queue | Implemented/documented | Atomic local queue, retained heartbeat/reader/release health, and task-oriented kiosk guide; advanced captive-portal compatibility remains unsupported |
| Consent-gated allowlisted telemetry and plain privacy notice | Runtime, collector, governance, and fresh endpoint active | Random install ID, release version, active kiosk count, scrubbed category, connection-derived metro; isolated HMAC collector, 30-day retention, maintainer aggregates, authenticated deletion, incident policy, live health, and synthetic report/aggregate/deletion workflow checks |
| Accessible task-first public documentation with annotated visuals | Published | Dashboard, GitHub, Cloudflare, OAuth, kiosk, and integrations visuals; WCAG 2.2 A target; `https://isriah.github.io/LancerLogin/` |
| Community support without SLA | Implemented | `robolancers@gmail.com` is documented with explicit no-SLA language |

## Verification boundary

Automated tests use fake D1 bindings, provider responses, Cloudflare resource lists, and R503 transport. The dedicated community telemetry workflow was executed only against a fresh collector-only Cloudflare account and passed its live self-tests. No adopter provisioning workflow, provider delivery, Pi installation, or sensor operation has been performed from this project. Those acceptance steps require a separate fresh LancerLogin-only adopter target and must never use an existing attendance installation.

The detailed requirement-to-evidence matrix is maintained in `docs/COMPLETION-AUDIT.md`.

Both `.github/workflows/ci.yml` and `.github/workflows/release.yml` run the account-neutral `verify:migrations` gate against a fresh local D1 database before accepting a commit or tag.
