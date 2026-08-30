# Architecture Decision Record

## ADR-001: Single-kiosk, local fingerprint boundary

LancerLogin supports exactly one paired kiosk per installation. The Raspberry Pi talks to the R503 reader locally; template enrollment, matching, and slot mapping never leave the device. Cloud data may record a non-biometric member identifier, scan result, timestamp, and kiosk health. Multi-kiosk and biometric synchronization are explicitly out of scope.

## ADR-002: Adopter-owned cloud account

Each adopter deploys to their own Cloudflare account from a GitHub template. A narrowly scoped Cloudflare token is supplied as a GitHub Actions secret. The action will create only resources named from a user-selected installation slug: Worker, D1 database, Pages project, and deployment secrets. This repository ships only a dry-run validator until an adopter supplies a fresh target.

## ADR-003: Authentication and authorization

Setup selects Google OAuth, local username/password, or both. Local credentials use a modern memory-hard salted password hash (Argon2id) and never recover a password; the local setup tool resets credentials. Admins have full access. Operators manage meetings, attendance, corrections, excuses, reports, and kiosk status, but cannot manage users, security, integrations, branding, or destructive configuration.

## ADR-004: Secret and privacy model

Integration credentials are encrypted with a per-installation key held as a Worker secret; APIs never return saved secret values. Telemetry starts only after explicit first-admin consent and contains only random installation ID, release version, active kiosk count, scrubbed errors, and a coarse city/metro derived transiently from the connection. It excludes roster, attendance, biometric, organization, and raw IP data.

## ADR-005: Retention and recovery

Data remains until an admin exports or deletes it. CSV exports and documented D1 backup/restore are supported. There is no migration from other systems and no PDF or spreadsheet integration.

