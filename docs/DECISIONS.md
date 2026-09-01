# Architecture Decision Record

## ADR-001: Single-kiosk, local fingerprint boundary

LancerLogin supports exactly one paired kiosk per installation. The Raspberry Pi talks to the R503 reader locally; template enrollment, matching, and slot mapping never leave the device. Cloud data may record a non-biometric member identifier, scan result, timestamp, and kiosk health. Multi-kiosk and biometric synchronization are explicitly out of scope.

## ADR-002: Adopter-owned cloud account

Each adopter creates a private deployment repository from the public GitHub template and deploys a selected public release tag into their own Cloudflare account. The workflow refuses to deploy from a public repository. A narrowly scoped Cloudflare token and one-time first-Admin setup code are stored as private GitHub environment secrets. The guarded action creates only resources named from a user-selected installation slug: Worker, D1 database, Pages project, and Worker secrets. Create refuses name collisions; Resume handles an interrupted first deployment; Upgrade preserves D1 and existing secrets.

## ADR-003: Authentication and authorization

Setup selects Google OAuth, local username/password, or both. Local credentials use salted scrypt (N=32768, r=8, p=1) and never recover a password; the local setup tool resets credentials. Admins have full access. Operators manage meetings, attendance, corrections, excuses, reports, and kiosk status, but cannot manage users, security, integrations, branding, or destructive configuration.

## ADR-004: Secret and privacy model

Integration credentials are encrypted with a per-installation key held as a Worker secret; APIs never return saved secret values. The first-Admin form calls community metrics **anonymous usage reporting**, enables it by default, and provides a direct opt-out checkbox. When enabled it contains only random installation ID, release version, active kiosk count, scrubbed errors, and a coarse city/metro derived transiently from the connection. It excludes roster, attendance, biometric, organization, and raw IP data.

The guided setup is a paginated, cross-Admin wizard ordered to remove dependencies: organization and brand, initial test meeting, roster, kiosk pairing, kiosk input test, and attendance confirmation. Discord remains optional and malformed Discord IDs cannot block core roster import. A browser simulator uses its own pairing-code purpose, has no hardware kiosk credential, does not count as an active kiosk, and may submit attendance only to test-marked meetings.

## ADR-005: Retention and recovery

Data remains until an admin exports or deletes it. CSV exports and documented D1 backup/restore are supported. There is no migration from other systems and no PDF or spreadsheet integration.
