# Implementation roadmap

Each unit ended with targeted tests, full typecheck/build gates, a focused commit, and updated handoff notes.

| Unit | Deliverable | Status |
| --- | --- | --- |
| 0–1 | Sanitized Apache-2.0 repository, decisions, domain contracts, D1 schema, authorization harness | Complete |
| 2–3 | Accessible dashboard, local/Google auth, shared onboarding, branding, users, roster, meetings, attendance, corrections/excuses, CSV, deletion | Complete in local/mock verification; completion audit added immediate session revocation and formula-safe CSV |
| 4 | Guided Pi installer, 800×480 touch UI, R503 match/enrollment protocol, local mappings, persistent offline queue, hashed pairing, retained reader/release health | Complete with injected serial transport, local D1 migration, and browser verification; physical hardware acceptance pending |
| 5–6 | AES-GCM integration administration, Resend attendance mail, Discord linking/pings/contests/calendar/status | Complete with mocked provider responses |
| 7 | Opt-out anonymous usage reporting runtime, isolated collector, privacy notice, CSV and D1 backup/restore | Complete; fresh collector deployed, live health verified, synthetic report/aggregate/deletion checks passed, and reviewed endpoint activated in adopter configuration |
| 8 | Guided one-task setup, local error placement, optional Discord roster data, and browser simulator | Complete; simulator is Admin-only, credential-separated, and active-meeting based |
| 9 | Explicit existing-installation Upgrade operation | Complete; requires all adopter resources, applies migrations, preserves data and Worker secrets |
| 10 | Routed dashboard, top-level roster/account linking, category backups/restores/deletes, onboarding celebration, responsive containment, and manual dashboard update assistant | Complete in local/mock verification; live upgrade intentionally left for user acceptance |
| 11 | Complete attendance sessions, rolling operations Home, organization-wide cutoff, signed Discord contests, Kiosks page, and adaptive branding | Complete; accepted through subsequent adopter upgrades |
| Release | Guarded adopter-owned GitHub/Cloudflare provisioning, version-matched release packaging, dashboard-linked installer, accessible GitHub Pages docs, annotated dashboard/GitHub/Cloudflare/OAuth/kiosk/integration visuals | Complete; no provisioning workflow executed by this project |
| 12 | Public-source/private-deployment separation, release-tag selection, authenticated updater routing, and one-time first-Admin setup code | Complete; isolated private Create and Upgrade accepted |
| 13 | Recurring meetings, searchable full meeting editor, roster preview/replace, persistent dark-first theme, streamlined onboarding, release notification, and in-dashboard integration guides | Complete and accepted through the adopter's v0.7.0 upgrade |
| 14 | End-to-end provider verification, collapsible integration setup, latest-stable update dropdown, and prior-month calendar shading | Complete in v0.7.0; manual dashboard upgrade accepted, provider-specific manual checks continue |
| 15 | Primary roster directory, individual member dialog, neutral themed UI, Hex/RGB colors, self-hosted fonts, LAN-assisted one-key Pi pairing, Playwright smoke tests, and actionlint | Complete locally for v0.8.0; manual adopter Upgrade and physical pairing acceptance pending |
| 16 | Non-overlapping attendance windows, automatic kiosk meeting resolution, continuous R503 experience, local Wi-Fi/fingerprint tools, dashboard lifecycle/recovery, and hardened Pi installation | Complete locally for v0.9.0; manual adopter Upgrade and final physical acceptance pending |
| Acceptance | Raspberry Pi display/UART/R503 installation and fingerprint workflow | In progress on dedicated user hardware; do not claim complete until recorded |
| Future | A 1:1 browser simulator built from the same kiosk screen, state transitions, and attendance logic as the physical kiosk; substitute a roster-member event control for the R503 and simulate hardware-only responses | Deferred by product decision; keep the existing setup simulator, require simulator-origin audit data, and prevent the physical and browser implementations from drifting |

## Release exclusions

No multi-kiosk operation, biometric synchronization, live migration from another installation, PDF export, Sheets export, captive-portal automation, or connection to an existing deployment. Exported roster rows and local R503 slot mappings may be prepared for import without moving biometric templates.
