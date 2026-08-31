# Community release requirement checklist

This checklist maps the approved Community Release Plan to durable implementation and verification evidence. “Implemented” means the repository is ready for mock/local verification; it does not claim a real Cloudflare deployment or physical hardware test.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Standalone LancerLogin project, Apache-2.0, clean history, no migration or legacy connection | Implemented | `LICENSE`, `docs/DECISIONS.md`, sanitizer tests in `tests/foundation.test.mjs` |
| Clubs, classrooms, teams, and arts groups; one kiosk only | Implemented | `README.md`, shared product policy, one-active-kiosk D1 constraint, replacement tests |
| Pi 3B+/4/5, at least 1 GB; Waveshare 7-inch DSI LCD (E); R503; Wi-Fi/Ethernet | Implemented in guide/installer | `docs/KIOSK.md`, installer hardware checks, 800×480 browser visual; physical acceptance pending |
| Fingerprint templates remain exclusively in the R503 | Implemented with mocked serial transport | R503 protocol, local slot mapping, schema/sanitizer tests; physical acceptance pending |
| Browser-led GitHub template and adopter-owned Cloudflare setup | Implemented without a target account | Manual guarded workflow derives exactly one token-scoped account at runtime, creates Worker/D1/Pages, and outputs the Pages URL |
| Guided Pi setup without clone or manual source edits; short-lived one-time pairing | Implemented | Dashboard installer link, version-matched checksummed installer, hashed ten-minute code, owner-only kiosk credential |
| Local, Google, or both authentication modes | Implemented | First-Admin bootstrap, salted scrypt, OAuth state/claim validation, encrypted Google secret, local recovery tool |
| Fixed Admin and Operator roles | Implemented | Worker route authorization plus dashboard policy and permission tests |
| Resumable cross-Admin non-modal setup checklist | Implemented | Persisted setup progress for branding, roster, pairing, fingerprint test, test meeting, and attendance confirmation; complete state hides and can reopen |
| Organization branding and light/dark/themed modes | Implemented | D1-backed name, subtitle, bounded local logo data, primary/secondary colors, appearance application |
| Retention, CSV, deletion, and D1 backup/restore | Implemented | Authenticated CSV, typed-confirmation Admin deletion, `docs/BACKUP-RESTORE.md`; no PDF or Sheets |
| Google, Resend, and full Discord administration/workflows | Implemented with mocked providers | Encrypted status/save/test/rotate/remove, attendance mail, linking, missing-member notices/contests, calendar mapping, persistent kiosk status |
| Manual captive-portal handling and offline-first queue | Implemented/documented | Atomic local queue and task-oriented kiosk guide; advanced captive-portal compatibility remains unsupported |
| Consent-gated allowlisted telemetry and plain privacy notice | Runtime and collector implemented | Random install ID, release version, active kiosk count, scrubbed category, connection-derived metro; isolated HMAC-hashing collector with rate limits, aggregate-only access, and configurable retention; endpoint/operator policy pending |
| Accessible task-first public documentation with annotated visuals | Published | Dashboard, GitHub, Cloudflare, OAuth, kiosk, and integrations visuals; WCAG 2.2 A target; `https://isriah.github.io/LancerLogin/` |
| Community support without SLA | Implemented | `robolancers@gmail.com` is documented with explicit no-SLA language |

## Verification boundary

Automated tests use fake D1 bindings, provider responses, Cloudflare resource lists, and R503 transport. No provisioning workflow, provider delivery, Cloudflare mutation, Pi installation, or sensor operation has been performed from this project. Those acceptance steps require a fresh LancerLogin-only adopter target and must never use an existing attendance installation.
