# Changelog

Meaningful release notes are published in [`docs/releases`](docs/releases/) and attached verbatim to each GitHub Release. LancerLogin follows semantic versioning while the Community Edition matures.

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
