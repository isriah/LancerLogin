# Dashboard interaction contract

The dashboard is keyboard-first: it has a skip link, labeled primary navigation, visible text controls, semantic headings, and no modal-dependent onboarding. It targets WCAG 2.2 A; the implementation will add automated accessibility checks when the production UI framework is introduced.

The Setup checklist is a persisted installation-level record, not per-user state. Any Admin can resume it. When every required item is complete, the primary card is hidden and **Setup and help** keeps it reachable. Optional integrations never block completion.

Operators can work with meetings, attendance, corrections/excuses, reports, and kiosk status. They cannot see or access People, Branding, Integrations, Security, or destructive configuration.
