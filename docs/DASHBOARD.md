# Dashboard interaction contract

The dashboard is keyboard-first: it has a skip link, labeled navigation and controls, semantic headings, live status regions, and no modal-dependent onboarding. It targets WCAG 2.2 A. Automated structural checks and browser verification cover the production React interface.

The dashboard uses real, deep-linkable pages rather than loading every category into one expandable screen. Home, Meetings, Attendance, Reports, Roster, and Setup have their own paths. Admin settings have separate Organization, Integrations, Privacy, Data, and Updates paths. A Pages fallback serves the app shell when a user refreshes one of those paths.

The Setup checklist is a persisted installation-level record, not per-user state. Any Admin can resume it. The guided workflow focuses on one task at a time. When the final attendance check is confirmed, an accessible confetti celebration and completion dialog appear; dismissing the dialog moves to dashboard Home. Setup stays reachable from the primary navigation. Optional integrations never block completion.

Each completed item records the Admin and time that completed it. Admins can reopen a required item when a configuration needs review; optional integrations use their own status and do not affect the required checklist.

Operators can create and edit meetings, copy a selected meeting ID to the kiosk, view the roster, manage attendance and reasoned corrections/excuses, export reports, and monitor kiosk status. They cannot modify the roster or access organization settings, users and credentials, integrations, privacy controls, updates, or destructive configuration.

Roster is a top-level page. Admins may explicitly link one roster member to one dashboard account and assign Admin or Operator access, or create a non-rostered Admin/Operator account. Roster membership alone never grants authentication, and unlinking a roster member does not delete the dashboard account.

Branding stores an optional bounded PNG, JPEG, or WebP logo directly in D1, never as an externally fetched URL. Organization name and subtitle apply in every appearance. **Organization colors** is an explicit themed mode that applies the saved primary and secondary colors; light, dark, and follow-device modes use the accessible LancerLogin palette. The header mode button is a temporary per-page light/dark override and does not silently rewrite installation branding. The unbranded default remains LancerLogin.

The shared attendance workspace shows the active kiosk heartbeat, retained reader state, and reported kiosk release, refreshes status every 30 seconds, supports roster-to-Discord linking, and lists open or resolved Discord attendance contests for the selected meeting. When Discord is configured, heartbeats automatically update the single persistent status message when its rendered state changes; a five-minute scheduled pass reconciles stale kiosks to offline.

The Updates settings page compares the installed Worker release with the latest public GitHub release. Beginning an update first downloads an entire-installation backup and then opens the guarded GitHub workflow. The dashboard never stores Cloudflare or GitHub write credentials and never dispatches a deployment itself.
