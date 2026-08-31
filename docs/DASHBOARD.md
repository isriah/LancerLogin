# Dashboard interaction contract

The dashboard is keyboard-first: it has a skip link, labeled navigation and controls, semantic headings, live status regions, and no modal-dependent onboarding. It targets WCAG 2.2 A. Automated structural checks and browser verification cover the production React interface.

The Setup checklist is a persisted installation-level record, not per-user state. Any Admin can resume it. When every required item is complete, the primary card is hidden and **Setup and help** keeps it reachable. Optional integrations never block completion.

Each completed item records the Admin and time that completed it. Admins can reopen a required item when a configuration needs review; optional integrations use their own status and do not affect the required checklist.

Operators can create and edit meetings, copy a selected meeting ID to the kiosk, manage attendance and reasoned corrections/excuses, export reports, and monitor kiosk status. They cannot see or access People, Branding, Integrations, Security, or destructive configuration.

Branding stores an optional bounded PNG, JPEG, or WebP logo directly in D1, never as an externally fetched URL. Organization name and subtitle apply in every appearance. **Organization colors** is an explicit themed mode that applies the saved primary and secondary colors; light, dark, and follow-device modes use the accessible LancerLogin palette. The header mode button is a temporary per-page light/dark override and does not silently rewrite installation branding. The unbranded default remains LancerLogin.

The shared attendance workspace shows the active kiosk heartbeat, retained reader state, and reported kiosk release, refreshes status every 30 seconds, supports roster-to-Discord linking, and lists open or resolved Discord attendance contests for the selected meeting.
