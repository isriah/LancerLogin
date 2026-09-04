# Dashboard design-conformance initiative

## Outcome

Bring every surface governed by `docs/UI-STANDARDS.md` into the shared visual-language contract, then publish the completed pass as v0.19.0. The work is intentionally serial because the surfaces share the dashboard shell, semantic tokens, form controls, dialogs, and responsive CSS.

This initiative begins after published v0.18.0. It does not change product policy, authorization, stored data, provider behavior, or kiosk attendance behavior.

## Scope boundary

Included:

- first-Admin bootstrap, local/Google sign-in, authentication checks, errors, and recovery-facing states rendered by the React dashboard;
- embedded guided setup, every setup step, progress, validation, skip/reopen states, and completion overlay;
- authenticated shell, primary and Settings navigation, theme control, contest and update indicators/popups, loading overlay, redirects, and unavailable-page state;
- Dashboard Calendar/Table, meeting selector, creation dialog, bulk controls, empty/error/status/Undo states;
- canonical meeting detail, lifecycle summary, Discord operations, contest review, attendance table and corrections, unavailable state, and edit/duplicate/delete dialogs;
- Reports, Roster, member detail, roster import preview, and add/edit member dialogs;
- Kiosks dashboard health, physical-device actions, pairing dialog, maintenance callout, Discord status sync, device history, and the dashboard card/link for the browser simulator;
- Settings > Organization, Configuration, Access, Integrations, Privacy, Data, Guided Setup, and Updates, including all expanded, disabled, configured, validation, confirmation, degraded, success, and error states.

Excluded:

- physical kiosk presentation and its local maintenance/network pages;
- the browser kiosk simulator's kiosk-display presentation at `/simulator` (its dashboard entry point remains in scope);
- GitHub/Cloudflare provisioning pages outside the React dashboard;
- public documentation styling;
- private adopter deployment, Cloudflare mutation, Upgrade workflow dispatch, service restart, and Pi update.

## Required design contract

All touched UI reuses the existing semantic tokens and established patterns from `docs/UI-STANDARDS.md`:

- typography: `--font-body`, `--font-display`, and the caption/small/body/card/section/page text roles;
- spacing: the quarter-rem `--space-*` scale, with layout expressed through `gap` unless a section boundary requires a margin;
- shape: `--radius-control`, `--radius-card`, `--radius-panel`, and `--radius-pill` according to hierarchy;
- controls: `--control-min-block-size`, shared input/select/textarea/file/button treatment, inset select arrow, visible labels, and 44px activation targets;
- color: `--ui-*` surface, text, border, focus, success, warning, and error roles; brand colors may emphasize but never carry state alone;
- structure: one semantic `h1` per page, correctly nested headings, vertically centered single-line rows, deliberate top alignment for multiline rows, one primary action per group, links for navigation, buttons for actions;
- accessibility: visible focus, logical order, focus containment/return for overlays, associated instructions/errors, persistent non-color cues, reduced-motion alternatives, and meaningful landmarks/live regions/table relationships.

No standards exception is planned. Any newly discovered exception must be recorded with its reason in the owning work-unit handoff and resolved or explicitly represented as a blocked follow-up before final convergence.

## Contract matrix

Each row below is inspected in its meaningful loading, empty, populated, success, error, disabled, and configured/degraded states. Role-limited states are exercised with the applicable Admin or Operator account.

| Area | Routes and surfaces | Overlays and state variants |
| --- | --- | --- |
| Authentication | boot/auth check, first-Admin bootstrap, local sign-in, Google sign-in | mode selection, validation, pending, denied, locked/error, Google-only and dual-auth presentation |
| Guided setup | embedded setup organization, roster, kiosk/simulator path, input test, attendance confirmation | progress, skipped/completed steps, validation/status, completion celebration |
| Shared shell | all governed routes | desktop/mobile navigation, Settings hierarchy, theme switch, loading overlay, contest dialog, update popup, redirects, unavailable page |
| Dashboard | `/dashboard`, legacy `/meetings` redirect | Calendar/Table, search/selection/bulk actions, meeting selector, create dialog, empty/error/status/Undo |
| Meeting detail | `/meetings/[ID]`, legacy `/attendance` redirect | lifecycle variants, Discord configured/unconfigured and timing gates, contest list, attendance states/actions, edit/duplicate/delete dialogs, unavailable meeting |
| Reports | `/reports` | period/type/roster filters, saved views, trend/leaderboard, CSV action, empty and preserved-history states |
| Roster | `/roster`, `/roster/[ID]` | search/filter, Admin/Operator controls, add/edit dialogs, CSV import/preview/errors, active/inactive and linked/unlinked member states, unavailable member |
| Kiosks dashboard | `/kiosks` and simulator entry card | paired/unpaired, healthy/degraded/offline, Admin/Operator controls, Discord configured/unconfigured, pairing, maintenance, device history, action feedback |
| Settings | `/settings/organization`, `/configuration`, `/access`, `/integrations`, `/privacy`, `/data`, `/guided-setup`, `/updates` | enabled/disabled/configured provider cards, form errors/success, data backup/restore/delete dialog, telemetry states, update current/available/degraded states |

## Reference combinations

For every matrix row:

- desktop: 1280x900;
- mobile: 390x844;
- light and dark modes;
- representative adopter branding using primary `#7c3aed` and secondary `#0f766e`;
- keyboard-only traversal for all interactive paths;
- reduced motion for animated loading, progress, popup, and completion behavior;
- Admin and Operator variants wherever their available elements differ.

Automated tests should cover stable contracts and geometry. Manual browser inspection covers visual hierarchy, wrapping, contrast, alignment, and state quality that is not usefully reduced to source assertions. Sanitized evidence may be stored only when it contains no credentials, personal data, or biometric data.

## Serial milestones

1. Inventory and shared foundations: establish a durable executable matrix, converge semantic tokens, shell layout, global controls, loading, shared dialog/card/form/table patterns, and common responsive behavior.
2. Authentication and guided setup: conform every pre-auth and setup state, including completion.
3. Dashboard and meeting operations: conform meeting browsing, creation, detail, Discord/contest/attendance states, and management dialogs.
4. Roster and reporting: conform Reports, Roster, member detail, import, and member dialogs.
5. Kiosks dashboard: conform dashboard-owned kiosk health and management without changing the kiosk display.
6. Settings: conform every Settings category and its dialogs, expanded/configured/degraded states, and update presentation.
7. Final convergence audit: run the complete matrix on the integrated tree, repair remaining governed violations, document any deliberate exception, and prove no unresolved standards violations remain.

Each milestone is one work unit and one implementation task. Each is integrated and verified before the next begins so shared-foundation changes cannot race or invalidate downstream visual evidence.

## Verification and stop conditions

Every implementation unit must run `npm run verify:dashboard` plus focused Playwright coverage for its changed interactions and matrix rows. After each integration, rerun the affected checks and the unfiltered browser suite. Run API or documentation verification when a changed contract crosses those boundaries.

The final convergence unit additionally requires:

- the complete matrix at both reference sizes, both themes, representative brand colors, applicable roles, keyboard operation, and reduced motion;
- no page-level horizontal overflow at 390px; only documented contained data scrollers may overflow internally;
- no clipped labels, controls, focus rings, dialogs, popups, or status content;
- one page `h1`, valid heading order, visible labels, associated validation, correct action/link roles, and focus containment/return;
- no new arbitrary typography, spacing, radius, control-size, or semantic-color literals that duplicate a contract token;
- `npm run verify:dashboard`, the unfiltered browser suite, and `npm run verify:release` passing on the final v0.19.0 candidate;
- exact-commit GitHub Verify success and immutable v0.19.0 publication.

The goal is complete only when v0.18.0 and v0.19.0 are both published and the final matrix has no unresolved governed-surface violation. Publication does not authorize deployment to a private installation or Pi.
