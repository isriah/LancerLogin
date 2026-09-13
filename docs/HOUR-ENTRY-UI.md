# Staff hour entry workspace (WU-106)

Dependencies: WU-100 catalog UI, WU-101 civil-time service, WU-102 accounting and the WU-105 private member/window selectors. The existing `/hours` capability boundary now offers Catalogs, Entries and Reporting windows. Catalogs remain the initial view. All enabled accounts with `hours.manage` use the same entry controls; Staff gain no core roster or attendance administration routes.

## Entry workflow

Entries support bounded list pages, applied member/activity/status/service-date filters, creation, current detail, reasoned correction, terminal void and immutable revision pages. Current roster and activity names are explicitly labeled as current names, including in history; names are not invented historical snapshots. Private named selectors preserve external roster IDs as strings and offer an explicit inactive-member option for trusted Staff historical entry. Existing dated activities, including archived activities, remain selectable through the Staff path. Team/task entry can find or create its canonical dated activity through the accounting API.

Clock fields reuse the catalog clock component and shared civil-time service. Start/end folds are independently explicit; the next-day checkbox advances a calendar date, not 24 elapsed hours. Duration preview uses exact elapsed integer minutes, rejects future completion and has no break or total override. The server remains authoritative for overlap and accounting. Every entry creation and correction includes its displayed service date, using the existing server date check and atomic activity revision fence. Original receipts must match that date for every target. New submissions send the displayed `expectedTimeZone`; corrections keep their saved zone.

Read-only records and original receipts validate recorded offset arithmetic, exact instants and integer elapsed duration without reinterpreting old clocks through the browser's current IANA rules. Thus a timezone-data update does not hide history or prevent voiding. The correction form warns when current resolution differs and requires explicit acknowledgment before recalculating. Void requests contain only revision/reason and preserve recorded timing on the server.

Creation freezes its exact JSON payload and a random idempotency key in component memory. No automatic mutation retry occurs. A response failure locks the form; the explicit **Retry exact submission** action repeats only the frozen payload/key. Once a validated original receipt identifies the entry, recovery performs GET detail rather than another POST. The original receipt is checked against the submitted clocks, zone, activity/date and notes; current accounting state is then read separately because the original submission may already have been corrected or voided. Discarding an uncertain draft warns that it may already exist and requires list reload/review before a fresh submission. Reloading the browser loses this in-memory recovery state; no personal draft data or key is persisted to browser storage.

Corrections, voids and window/settings changes require a valid mutation result and matching current read-back before confirmation. Failure or malformed responses lock further mutations until explicit reload. Applied list filters remain stable during pagination and mutation refreshes. New hour requests time out after 15 seconds. Current-name reads run at most four concurrently with a 100-item pending bound; unavailable names can be reloaded explicitly. No raw opaque identity is a normal entry field.

## Reporting windows

Staff can edit reporting days (1–365) and default reopening hours (1–168), open one past event or all past events, inspect paginated existing/expired/revoked windows and revoke a window with its revision. The event selector filters through the day before the server's current installation date. Global event reopening never opens historical team/task dates. Existing expiry times do not change when the default duration changes. Single-window read-back confirms creation/revocation without scanning every historical page. Visible expiry instants are explicitly UTC; provider calls are not involved.

## UI review and verification

The workspace reuses the Hours card/grid/action/native-select patterns and the shared typography, spacing, semantic colors, radii, 44px target and focus tokens. Forms are inline; there is one page `h1`. Opening a form focuses its heading, closing restores focus to Entries, and mutation/recovery results focus the status notice. Destructive void controls use semantic error styling. Long selected names are repeated outside native selects so mobile clipping does not hide their identity. No UI-STANDARDS exceptions were needed.

Candidate evidence is local/mock only:

- `npm run verify:dashboard`: 34 JavaScript tests, 7 TypeScript tests and dashboard typecheck.
- `npm run test:browser -- hour-entries.spec.ts --workers=4`: 19 focused Chromium tests passed. Fixtures cover inactive historical entry, correction/void/history, canonical team/date identity, gaps/folds/next-day/fractional minutes, exact-key retry, known-receipt GET recovery, malformed receipts/reads, stale zones/revisions, grant revocation, applied paging and reporting settings/windows.
- The saved-offset regression deliberately uses valid recorded offsets different from current browser rules and verifies current display, immutable history, explicit correction warning and successful void.
- Eight entry/reporting screenshots were inspected in light/dark modes at 1280×900 and 390×844 with reference custom branding. Keyboard focus, control targets, long selected names and absence of horizontal page overflow were checked. Screenshots contain synthetic fixtures and remain ignored artifacts.
- Existing catalog and Staff-isolation browser tests passed in the affected combined run.

These fixtures exercise the real dashboard with mocked HTTP responses, not hosted accounting or provider acceptance. This unit changes no API, migration, dependency, external resource or deployment. Correction-request inbox and aggregate-report UI await the subsequent agreed unit and are not presented as functional here.
