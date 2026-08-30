# Implementation roadmap

Each unit ends with targeted tests, typecheck/build where applicable, full verification, a focused commit, and a handoff note.

| Unit | Deliverable | Verification gate |
| --- | --- | --- |
| 0 | Sanitized repository foundation, decisions, docs, dry-run CI | full local verification |
| 1 | Shared domain contracts, D1 migrations, Worker test harness | migration and authorization tests |
| 2 | Dashboard shell: accessible auth, Admin/Operator navigation, themes, resumable checklist | component/a11y tests and production build |
| 3 | Roster, meetings, attendance, corrections/excuses, CSV exports, deletion/audit | API integration tests |
| 4 | Guided Pi installer, local sensor adapter, offline queue, pairing code protocol, mock sensor tests | installer and service tests; no hardware connection |
| 5 | Google/local auth, Argon2id reset tool, secret vault and integrations management UI | security and negative-path tests |
| 6 | Resend workflows; Discord member linking, missing-member pings/contests, calendar, kiosk status | mocked provider contract tests |
| 7 | Opt-in telemetry, privacy notice, D1 backup/restore documentation | payload allowlist tests |
| 8 | GitHub template provisioning workflow, Cloudflare mock integration tests, GitHub Pages public docs and annotated screenshots | dry-run plus explicit real-target review |
| 9 | Hardware acceptance on an adopter-provided Pi and account | smoke checklist; no production cross-use |

## Release exclusions

No multi-kiosk operation, biometric synchronization, migration from another installation, PDF export, Sheets export, unsupported captive-portal automation, or connection to an existing deployment.

