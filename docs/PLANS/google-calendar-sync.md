# WU-074 — One-way Google Calendar meeting sync

## Outcome

Add an optional Admin-managed Google Calendar connection that mirrors newly created LancerLogin meeting occurrences into one selected writable calendar. LancerLogin remains authoritative, sends only generic identity plus start/end times, and saves meeting changes even when Google is unavailable.

## Decisions and boundaries

- Follow ADR-013: Calendar authorization is separate from Google sign-in; hiding deletes the mapped event; restoring creates a new event; provider failures use durable retries and never block meeting mutations.
- Request offline OAuth access with the narrow Calendar scopes needed to list writable calendars and maintain events.
- Do not import Google changes, invite attendees, send reminders, sync titles/notes, support multiple calendars, or backfill meetings created before verification.
- Disabling pauses sync without changing sign-in. Removing Calendar access clears local authorization and pending mapping state; previously delivered provider events may remain.

## Affected areas

1. D1 migration and backup schema for the enablement flag, encrypted Calendar authorization, current meeting-event mappings, and retry operations.
2. Worker routes for Admin-only setup, OAuth callback, writable-calendar selection, safe status, token refresh, provider calls, retries, and audits.
3. Meeting creation, occurrence/future-series edits, bulk and scoped deletion, and restoration hooks that enqueue and immediately attempt the matching operation.
4. Settings → Integrations Calendar card with the existing card, guide, native input/select, toggle, status, and action patterns.
5. Architecture, integration, security, dashboard, setup, and operational documentation.

## Dashboard visual contract

- Reuse `--font-body`, `--font-display`, the `--text-*` roles, `--space-*`, `--radius-control`, `--radius-card`, `--radius-panel`, `--control-min-block-size`, and `--ui-*` semantic status roles through existing integration components and CSS.
- Keep one page `h1`; the Calendar card uses the existing `h2`/`h3` hierarchy. Use labeled native inputs and selects, associated help text, 44px controls, visible focus, one primary action per form, and existing responsive card behavior.
- Verify keyboard use, 1280x900 and 390x844 layouts, light/dark modes, representative adopter colors, clipping, and page-level overflow. No standards exception is expected.

## Milestones

1. Add and verify migration/backup support.
2. Implement separate encrypted OAuth authorization and one-calendar verification without exposing credentials or tokens.
3. Implement deterministic event mappings, durable operations, bounded retries, and meeting lifecycle hooks.
4. Add the Admin Settings workflow and actionable queue status.
5. Update documentation and add focused API, dashboard, browser, migration, retry, privacy, role, and sign-in-isolation coverage.

## Verification and stop conditions

- Run `npm run verify:migrations`, `npm run verify:api`, `npm run verify:dashboard`, and `npm run verify:docs` when public setup guidance changes.
- Run focused browser coverage for Settings and meeting creation/edit/delete/restore at required viewports/themes, then the unfiltered browser suite after integration.
- Inspect outbound provider fakes to prove the field allowlist, deterministic idempotence, series scope, retry behavior, revocation/rate-limit handling, and no sign-in coupling.
- Stop before release tagging until a supported Google Calendar validates authorization, selection, create/update/delete/restore, and retry recovery. Release publication remains a separate authorized phase.
