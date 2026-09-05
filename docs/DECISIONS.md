# Architecture Decision Record

## ADR-001: Single-kiosk, local fingerprint boundary

LancerLogin supports exactly one paired kiosk per installation. The Raspberry Pi talks to the R503 reader locally; template enrollment, matching, and slot mapping never leave the device. Cloud data may record a non-biometric member identifier, scan result, timestamp, and kiosk health. Multi-kiosk and biometric synchronization are explicitly out of scope.

## ADR-002: Adopter-owned cloud account

Each adopter creates a private deployment repository from the public GitHub template and deploys a selected public release tag into their own Cloudflare account. The workflow refuses to deploy from a public repository. A narrowly scoped Cloudflare token and one-time first-Admin setup code are stored as private GitHub environment secrets. The guarded action creates only resources named from a user-selected installation slug: Worker, D1 database, Pages project, and Worker secrets. Create refuses name collisions; Resume handles an interrupted first deployment; Upgrade preserves D1 and existing secrets.

## ADR-003: Authentication and authorization

Setup selects Google OAuth, local username/password, or both. Local credentials use salted scrypt (N=32768, r=8, p=1) and never recover a password; the local setup tool resets credentials. Admins have full access. Operators manage meetings, attendance, corrections, excuses, reports, and kiosk status, but cannot manage users, security, integrations, branding, or destructive configuration.

## ADR-004: Secret and privacy model

Integration credentials are encrypted with a per-installation key held as a Worker secret; APIs never return saved secret values. The first-Admin form calls community metrics **anonymous usage reporting**, enables it by default, and provides a direct opt-out checkbox. When enabled it contains only random installation ID, release version, active kiosk count, scrubbed errors, and a coarse city/metro derived transiently from the connection. It excludes roster, attendance, biometric, organization, and raw IP data.

The guided setup is a paginated, cross-Admin wizard ordered to remove dependencies: organization and brand, roster, kiosk pairing, kiosk input test, and attendance confirmation. Discord remains optional and malformed Discord IDs cannot block core roster import. A browser simulator uses its own pairing-code purpose, has no hardware kiosk credential, does not count as an active kiosk, and may submit Admin-only attendance to an active selected meeting.

## ADR-005: Retention and recovery

Data remains until an admin exports or deletes it. CSV exports and documented D1 backup/restore are supported. There is no live migration from other systems and no PDF or spreadsheet integration. A local helper may prepare exported roster rows and R503 slot mappings for import without touching old cloud resources or moving biometric templates.

## ADR-006: Complete attendance sessions

Every meeting has a required start and end. A member scans once on arrival and once on departure; an arrival alone is active while the scan window remains open, a completed pair is present, and an incomplete or missing pair is absent after the window closes unless an audited correction or excuse overrides it. One organization-wide late-scan allowance applies after every scheduled end, defaults to 30 minutes, and cannot be overridden per meeting. Optional Discord absence processing runs every five minutes after that cutoff.

Meeting attendance windows may not overlap, including the organization-wide late-scan allowance. The rule applies to one-time creation, every occurrence in a recurring series, occurrence/future-series edits, and changes to the shared cutoff. This keeps unattended kiosk meeting resolution deterministic without asking members or kiosk operators to choose a meeting.

## ADR-008: Protected local kiosk operations

The physical kiosk is an unattended attendance appliance, not an administrator dashboard. Normal operation continuously scans the R503, resolves the eligible meeting through the Worker, and shows only member-facing status. Holding the network indicator opens touch Wi-Fi settings; holding the organization brand opens fingerprint maintenance. Both use one locally salted settings PIN and loopback-only operational routes. Admins may queue only fixed, short-lived dashboard commands: reload display, restart service, reboot Pi, reset the local PIN, or install Latest stable.

The update command is deliberately narrower than a remote shell. The kiosk service can start only `lancerlogin-update.service` through a unit-specific Polkit rule. That root-owned unit accepts no arguments and calls a fixed helper. The helper resolves only the official `isriah/LancerLogin` latest release in the `v0.n.n` namespace, verifies a published SHA-256 for the installer, and then relies on the installer’s existing SHA-256 check for the architecture-specific archive. It cannot use an administrator-provided URL, tag, command, or argument. A failed update starts the previously running kiosk service again.

## ADR-009: Discord designated-channel status placement

When Discord channel-manager mode is enabled, “status message at the top” means exactly one current LancerLogin-owned status message pinned in the configured attendance channel. If that tracked message is missing, LancerLogin recreates and pins its replacement. Pin, unpin, edit, and deletion operations remain limited to explicitly tracked LancerLogin-owned messages; unrelated and user-authored channel content is never reordered or modified.

## ADR-010: Attendance anomaly metric

The per-member mean anomalous-time statistic uses all preserved eligible meeting history from the member's participation start date. Reports-page date ranges and the operational reporting baseline apply only to the Reports screen at the time they are selected; they do not change statistics on member detail or other pages.

Each qualifying late check-in and early check-out is one separate value in the mean. For example, arriving 10 minutes late and leaving 20 minutes early contributes the values 10 and 20, not one combined 30-minute meeting value.

The dashboard displays the resulting mean in minutes rounded to the nearest whole minute.

Late-arrival and early-departure thresholds both default to 10 minutes. Admins may configure each threshold independently.

## ADR-011: Discord anomaly-report delivery

Attendance anomaly reports use a separate, Admin-configured private Discord channel rather than the member-facing attendance channel. LancerLogin requires that channel to belong to the already verified Discord server and refuses to use the configured attendance channel for this purpose. Adopters remain responsible for limiting channel access to the appropriate attendance staff.

The five-minute scheduler sends one report after each eligible meeting's late-scan window closes. A report contains that meeting's qualifying late-arrival and early-departure values under ADR-010, uses no mentions, and is tracked by meeting for retry safety. Meetings with no qualifying anomalies produce no Discord message. Enabling or changing the report channel starts a new delivery window at that time, so the feature does not backfill older meetings or deliver reports accumulated while it was disabled.
