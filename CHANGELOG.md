# Changelog

Meaningful release notes are published in [`docs/releases`](docs/releases/) and attached verbatim to each GitHub Release. LancerLogin follows semantic versioning while the Community Edition matures.

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
