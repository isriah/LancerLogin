# Dashboard visual-language standard

This document is the required design contract for all LancerLogin dashboard UI and public React forms. It preserves the current LancerLogin identity while keeping layout, typography, controls, scroll regions, and interaction states predictable. Read it before planning presentation work and use the review checklist before handing that work off.

The shared foundations are the safe default for existing and future content. A feature must not depend on browser-default control or scrollbar styling. If a requirement cannot follow a rule below, record the exception and reason in the change review.

## Scope and principles

This standard applies to the authenticated dashboard, its setup and sign-in flows, dashboard dialogs and popovers, walkthroughs, and public forms rendered by the dashboard application. It does not govern the physical kiosk, the kiosk simulator presentation, provisioning pages outside the React dashboard, or public documentation.

- Preserve the current visual character: Roboto for body and controls, Bebas Neue for display headings, adopter-selected primary and secondary colors, rounded panels, and calm light and dark surfaces.
- Prefer a shared token or established pattern over a page-local value. Add a semantic token only when an existing role cannot express a recurring need; explain the addition in the change review.
- Use semantic HTML first. Native controls are the default; custom ARIA widgets require an interaction that a native element cannot provide and focused keyboard coverage.
- Treat accessibility measurements as design defaults, not as a new claim of formal WCAG conformance. Deviations must be deliberate and documented.

## Token contract

Dashboard tokens live centrally in `apps/dashboard/src/styles.css`. New work uses these roles instead of repeating their literal values.

### Typography

| Role | Token | Default |
| --- | --- | --- |
| Body and controls | `--font-body` | Roboto with the existing system fallbacks |
| Display headings | `--font-display` | Bebas Neue with sans-serif fallback |
| Caption | `--text-caption` | `0.75rem` |
| Small supporting text | `--text-small` | `0.875rem` |
| Body | `--text-body` | `1rem` |
| Card heading | `--text-card-heading` | `1.2rem` |
| Section heading | `--text-section-heading` | `1.55rem` |
| Page heading | `--text-page-heading` | responsive `2.15rem` to `3.5rem` |

Use one semantic `h1` for the page title. Follow it with correctly nested headings; never choose a heading level for its rendered size. Display typography is for page, section, and card headings and may be used for fieldset legends. Body copy, labels, controls, table content, badges, and status text use the body family. Do not introduce another text size when one of the roles above communicates the same hierarchy.

Form field labels and legends that name a group of fields default to the body family and body size. Keep a group label as readable as its neighboring field labels. Use display typography for a legend only when it intentionally serves as a section or card heading, with an explicit heading-role token. Do not shrink legends to caption size or uppercase them solely to imply hierarchy.

Typography settings are future work. Components must depend on `--font-body` and `--font-display`, not the current family names, so a later settings feature can replace either role without rewriting component CSS.

### Spacing and shape

The spacing scale is quarter-rem based: `--space-0`, `--space-1` (`0.25rem`), `--space-2` (`0.5rem`), `--space-3` (`0.75rem`), `--space-4` (`1rem`), `--space-5` (`1.25rem`), `--space-6` (`1.5rem`), `--space-8` (`2rem`), and `--space-12` (`3rem`). Use the smallest value that makes the relationship clear; do not add arbitrary near-duplicates.

- `--control-min-block-size` is the standard `2.75rem`/44px control height.
- `--radius-control` is for buttons and form controls.
- `--radius-card` is for nested cards and callouts.
- `--radius-panel` is for primary page panels and dialogs.
- `--radius-pill` is reserved for badges, compact statuses, and segmented capsules.

Scrollable regions use `--ui-scrollbar-track`, `--ui-scrollbar-thumb`, and `--ui-scrollbar-thumb-hover`. Both axes must remain visible against their containing surface in light and dark themes. Do not restore operating-system default scrollbar colors in a page-local rule.

Cards use one padding value at a given hierarchy and the spacing scale between children. Avoid compensating margins inside a card. Page stacks, card stacks, and form rows use `gap`; individual margins are reserved for intentional separation from a different section.

Above the 800px mobile breakpoint, `apps/dashboard/src/desktop-layout.css` applies the shared desktop rhythm: `--card-padding` for every top-level card, a control-height card heading, one content inset across calendar cards, the `ui-button` type scale for action buttons, and one bordered plus-or-minus row for disclosures. It loads after every other dashboard stylesheet. Prefer the shared tokens and patterns in new page CSS; add a desktop rule there only when an existing page rule diverges from this rhythm, and keep narrow-screen layouts in their own stylesheets.

### Color roles

Use the `--ui-*` semantic aliases for new component CSS: surface, subtle surface, text, muted text, border, focus, success, warning, and error. These roles have light and dark values and remain independent of adopter brand colors where meaning must stay stable. Primary and secondary colors may identify brand and emphasis, but must not be the sole indication of success, warning, error, selection, or disabled state.

## Layout and alignment

- Vertically center single-line card headers, toolbars, action rows, labels beside controls, badges, and icon/text controls.
- Use top alignment only when at least one sibling is intentionally multiline or when comparing columnar detail. Do not inherit top alignment from a generic grid without checking the rendered content.
- Put the page title and its page-level actions in the page header. Put section actions in that section's header. Keep row actions with their row.
- Collection-management pages show the collection first. Put creation behind a clearly named Add action in the section header and open a focused dialog for the creation form. Do not leave a creation form permanently above or beside the collection unless creation is the page's sole task or the reviewed workflow explicitly requires it.
- Let action-row buttons size to their label on desktop. Use full-width actions only for deliberately dominant form submissions or narrow-screen stacking.
- Calendar and table workspaces that parallel Meetings use the `operational-browser-page` and `operational-page-intro` frame. Keep page navigation and conditional page actions inside that header so they do not move the shared browser controls or result card. Reuse `meeting-browser-controls`, `dashboard-meeting-calendar`, and `meeting-directory` rather than recreating their dimensions.
- A group has at most one primary action. Secondary, quiet, and destructive actions remain visually distinct; destructive styling is not reused for ordinary emphasis.
- Prefer existing responsive breakpoints and patterns. At 390px, controls must remain reachable without page-level horizontal scrolling; data tables may use their documented contained scrollers or responsive row treatment.

## Form controls

All controls need visible labels, an accessible name, a visible keyboard focus state, and defined hover, disabled, and error states. Supporting instructions follow the label and are associated with the control; validation text is associated with `aria-describedby`, and invalid controls use `aria-invalid`.

- Buttons trigger actions; links navigate. Their role and visual presentation must agree.
- Every new dashboard action button needs an explicit shared style. Use `ui-button` for a secondary action, add `ui-button--primary` for the one main action in its section, or add `ui-button--danger` for a destructive action. Do not rely on browser default button styling or on an incidental parent selector. Give a new variant a reusable class in `styles.css` before using it.
- Inputs, textareas, and native selects share the standard height, padding, border, radius, typography, and state treatment. Native selects use the established inset arrow and enough right padding to keep text clear of it.
- Use native checkboxes and radios. Their visual mark may be smaller than 44px, but the associated label provides at least a 44px activation area, and text aligns vertically with the mark.
- File inputs use the shared bordered field treatment and one `::file-selector-button` pattern. Show the selected filename as text when the browser control does not make it sufficiently clear.
- Use a custom combobox only for a demonstrated need such as filtering or asynchronous results. Implement the applicable WAI-ARIA keyboard and focus behavior and add focused browser tests.

The `.app` foundation supplies a low-specificity fallback for native buttons, text controls, selects, file inputs, disabled states, focus states, and scrollbars. Page-specific CSS may refine that foundation but must continue to use semantic tokens. New general-purpose controls use `ui-button`, `ui-button--primary`, `ui-button--danger`, `ui-control`, `ui-native-select`, `ui-checkbox`, and `ui-form`. A specialized control needs an established scoped selector and rendered coverage for its states.

## Executable conformance inventory

`apps/dashboard/src/design-conformance.ts` is the required surface inventory. It covers authentication, setup, Meetings, Attendance, Reports, Roster, Kiosks, Settings, Outreach, public Outreach submission, dialogs, popovers, walkthroughs, tables, calendars, and scroll regions. Every entry names the browser specifications that render its representative states.

`tests-ts/ui-control-inventory.test.ts` records every dashboard source file that contains raw native controls. A control-count change is a review event: prefer a shared control pattern, or deliberately update the inventory with the surface's focused browser coverage. `tests-browser/ui-foundations.spec.ts` proves that an otherwise unclassified native control and both scrollbar axes inherit tokens in light and dark themes.

The focused gate for presentation foundations is:

```powershell
node --experimental-strip-types --test tests-ts/dashboard-conformance.test.ts tests-ts/ui-control-inventory.test.ts
node scripts/run-browser-tests.mjs tests-browser/ui-foundations.spec.ts
```

The complete dashboard and browser gates remain required before a publication milestone. Kiosk presentation stays under its separate kiosk standards and verification.

## Accessibility defaults

- Aim for at least 4.5:1 contrast for normal text and 3:1 for large text, focus indicators, and meaningful component boundaries.
- Keep dashboard controls at least 44px tall by project convention. Where a visual control is smaller, its complete activation target remains at least 44px in the relevant direction.
- Preserve a visible focus indicator and logical keyboard order. Opening and closing overlays must follow the repository's focus-containment and focus-return patterns.
- Pair color with text, shape, iconography, or another persistent cue.
- Respect `prefers-reduced-motion`; removing motion must not remove status or progress information.
- Preserve semantic headings, landmarks, labels, live regions, and table relationships while styling them.

Reference guidance: [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), and [WAI-ARIA Authoring Practices patterns](https://www.w3.org/WAI/ARIA/apg/patterns/).

## Required planning and review checklist

Before implementation:

- Identify the existing layout, control, and semantic color patterns the change will reuse.
- Name the typography, spacing, shape, and control tokens required by the design.
- State whether any rule needs an exception and why.
- Include keyboard, light/dark theme, adopter-brand, desktop, and mobile checks in acceptance and verification.

Before handoff:

- Confirm heading hierarchy and one page `h1`.
- Confirm single-line rows are vertically centered and multiline rows are intentionally top-aligned.
- Confirm control labels, states, focus behavior, 44px targets, and primary-action hierarchy.
- Inventory every action button, native field, file chooser, and scroll region on the touched panel. Confirm each uses the shared style or an established scoped control, including controls shown only after a preview, error, or role change.
- Inspect at 1280x900 and 390x844 in light and dark modes using representative custom primary and secondary colors.
- For a new or changed panel, add focused browser coverage that checks computed button background, text, border, radius, and target size against the active theme tokens. Exercise representative hover, keyboard focus, disabled, and destructive states. A class-name assertion or screenshot alone does not prove that the rendered control is themed.
- Check for clipping, unintended horizontal page scrolling, inconsistent padding, and new literal values that duplicate a token.
- Run `npm run verify:dashboard` and the focused browser test for any changed interaction.
- Update the raw-control inventory only when the source change is intentional and its rendered states are covered.
