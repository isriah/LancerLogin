# Implementation roadmap

Each unit ended with targeted tests, full typecheck/build gates, a focused commit, and updated handoff notes.

| Unit | Deliverable | Status |
| --- | --- | --- |
| 0–1 | Sanitized Apache-2.0 repository, decisions, domain contracts, D1 schema, authorization harness | Complete |
| 2–3 | Accessible dashboard, local/Google auth, shared onboarding, branding, users, roster, meetings, attendance, corrections/excuses, CSV, deletion | Complete in local/mock verification |
| 4 | Guided Pi installer, 800×480 touch UI, R503 match/enrollment protocol, local mappings, persistent offline queue, hashed pairing, kiosk health | Complete with injected serial transport and browser verification; physical hardware acceptance pending |
| 5–6 | AES-GCM integration administration, Resend attendance mail, Discord linking/pings/contests/calendar/status | Complete with mocked provider responses |
| 7 | Consent-gated telemetry runtime, isolated collector, privacy notice, CSV and D1 backup/restore | Runtime and locally verified account-neutral collector complete; public operator/endpoint policy pending |
| 8 | Guarded adopter-owned GitHub/Cloudflare provisioning, version-matched release packaging, dashboard-linked installer, accessible GitHub Pages docs, annotated dashboard/GitHub/Cloudflare/OAuth/kiosk/integration visuals | Complete; no provisioning workflow executed by this project |
| 9 | Fresh adopter Cloudflare and Raspberry Pi acceptance | Pending an explicitly supplied standalone target |

## Release exclusions

No multi-kiosk operation, biometric synchronization, migration from another installation, PDF export, Sheets export, captive-portal automation, or connection to an existing deployment.
