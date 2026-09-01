# Changelog

Meaningful release notes are published in [`docs/releases`](docs/releases/) and attached verbatim to each GitHub Release. LancerLogin follows semantic versioning while the Community Edition matures.

## 0.9.0 — Unattended kiosk operations

- Prevent one-time, recurring, edited, and organization-cutoff meeting windows from overlapping.
- Replace typed meeting selection with automatic server-side meeting resolution for every fingerprint scan.
- Restore a continuous, full-screen R503 kiosk experience with familiar arrival/departure feedback, cached branding, semantic reader lighting, and an offline queue.
- Add PIN-protected touch Wi-Fi controls and local fingerprint maintenance while keeping templates exclusively inside the sensor.
- Manage pairing, replacement, history, health, maintenance guidance, and fixed recovery commands from the dedicated Kiosks page.
- Harden installation and upgrades around serial startup, port conflicts, service health, release packaging, and narrow Pi permissions.

See [`docs/releases/v0.9.0.md`](docs/releases/v0.9.0.md) for migration, Pi-upgrade, security, and verification details.

## 0.8.0 — Roster polish and remote kiosk pairing

- Make the roster directory the page focus, with modal CSV preview/replace and individual-member entry.
- Replace redundant meeting counts and inconsistent card gaps with a shared responsive page rhythm.
- Self-host Bebas Neue headings and Roboto body text; add themed Hex/RGB color editors and neutral dark surfaces.
- Let a phone or laptop pair a freshly installed Pi over the local network with one dashboard-generated, ten-minute key—no Cloudflare URL or OTP typing on the kiosk.
- Add focused Playwright browser smoke coverage and GitHub workflow linting alongside the existing full release gate.

See [`docs/releases/v0.8.0.md`](docs/releases/v0.8.0.md) for upgrade, security, and verification details.

## 0.7.0 — Verified integrations

- Require end-to-end Google, Resend, and Discord verification before showing an integration as configured.
- Send real expiring Resend codes and signed Discord verification buttons while storing only challenge hashes.
- Collapse configured cards and place setup fields directly beside their copy-and-paste instructions.
- Default the private updater to a **Latest stable** dropdown without routine release-tag typing.
- Subtly shade prior-month dates in the rolling Home calendar.

See [`docs/releases/v0.7.0.md`](docs/releases/v0.7.0.md) for migration, upgrade, and verification details.

## 0.6.1 — Kiosk status badge spacing

- Keep physical-kiosk and browser-simulator names consistently separated from their status badges.
- Increase status-badge horizontal padding and preserve wrapping at narrow widths.

See [`docs/releases/v0.6.1.md`](docs/releases/v0.6.1.md) for upgrade and verification details.

## 0.6.0 — Recurring meetings and dashboard refinement

- Add daily, weekly, biweekly, and monthly meeting series that preserve local wall time across daylight-saving changes.
- Replace the meeting cards with a searchable, complete meeting table and full occurrence/future-series editing.
- Add a confirm-before-write roster preview with merge and replace modes while preserving history and credentials.
- Refine onboarding, persistent dark-first browser themes, responsive/accessibility behavior, and page hierarchy.
- Notify Admins when a newer release is available without ever dispatching an update.
- Put guided Google OAuth, Resend, and Discord setup beside each integration form.
- Keep the full kiosk-screen simulator on the future-work list; the existing guided-setup simulator remains available.

See [`docs/releases/v0.6.0.md`](docs/releases/v0.6.0.md) for upgrade notes, limits, and validation details.

## 0.5.0 — Attendance lifecycle and operations home

- Require meeting end times and derive attendance from an arrival/departure scan pair.
- Add one organization-wide late-scan allowance, defaulting to 30 minutes with no meeting override.
- Add a five-week rolling Home calendar, live meeting rosters, outstanding Discord contests, and a top-level Kiosks page.
- Make guided setup temporary, resumable, and reachable from settings after completion.
- Apply organization colors in all appearances and adapt transparent logos for contrast without changing the stored original.
- Send Discord absence notices automatically on the five-minute schedule after the scan cutoff; accept only signed, delivered-recipient contest buttons and require an audited review note.
- Preserve pre-0.5 attendance credit, infer end times for legacy meetings that omitted them, keep v0.4 backups restorable, and add durable Discord delivery state.
- Repair first-time Worker secret upload and let private deployment workflows default to the latest release or choose a specific tag.

See [`docs/releases/v0.5.0.md`](docs/releases/v0.5.0.md) for upgrade notes and validation details.
