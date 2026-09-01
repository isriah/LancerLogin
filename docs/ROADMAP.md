# Implementation roadmap

Each unit ended with targeted tests, full typecheck/build gates, a focused commit, and updated handoff notes.

| Unit | Deliverable | Status |
| --- | --- | --- |
| 0–1 | Sanitized Apache-2.0 repository, decisions, domain contracts, D1 schema, authorization harness | Complete |
| 2–3 | Accessible dashboard, local/Google auth, shared onboarding, branding, users, roster, meetings, attendance, corrections/excuses, CSV, deletion | Complete in local/mock verification; completion audit added immediate session revocation and formula-safe CSV |
| 4 | Guided Pi installer, 800×480 touch UI, R503 match/enrollment protocol, local mappings, persistent offline queue, hashed pairing, retained reader/release health | Complete with injected serial transport, local D1 migration, and browser verification; physical hardware acceptance pending |
| 5–6 | AES-GCM integration administration, Resend attendance mail, Discord linking/pings/contests/calendar/status | Complete with mocked provider responses |
| 7 | Opt-out anonymous usage reporting runtime, isolated collector, privacy notice, CSV and D1 backup/restore | Complete; fresh collector deployed, live health verified, synthetic report/aggregate/deletion checks passed, and reviewed endpoint activated in adopter configuration |
| 8 | Guided one-task setup, local error placement, optional Discord roster data, and browser simulator | Complete; simulator is Admin-only, credential-separated, and test-meeting-only |
| 9 | Explicit existing-installation Upgrade operation | Complete; requires all adopter resources, applies migrations, preserves data and Worker secrets |
| 10 | Routed dashboard, top-level roster/account linking, category backups/restores/deletes, onboarding celebration, responsive containment, and manual dashboard update assistant | Complete in local/mock verification; live upgrade intentionally left for user acceptance |
| 8 | Guarded adopter-owned GitHub/Cloudflare provisioning, version-matched release packaging, dashboard-linked installer, accessible GitHub Pages docs, annotated dashboard/GitHub/Cloudflare/OAuth/kiosk/integration visuals | Complete; no provisioning workflow executed by this project |
| 11 | Manual feedback-release upgrade acceptance and Raspberry Pi hardware acceptance | GitHub upgrade intentionally pending user test; physical hardware pending |

## Release exclusions

No multi-kiosk operation, biometric synchronization, migration from another installation, PDF export, Sheets export, captive-portal automation, or connection to an existing deployment.
