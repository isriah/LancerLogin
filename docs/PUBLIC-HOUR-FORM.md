# Public member hour form

WU-114 implements `/submit-hours`. Dependencies: WU-111 public HTTP contract; WU-101 civil-time resolver; hosted normal ingress acceptance additionally requires WU-112. The route mounts before the authenticated application, even when a dashboard session cookie exists. The enabled Hour Tracking workspace links to it with an ordinary same-origin navigation link containing no member data.

## Settled product behavior

Members submit without sign-in using a string ID (leading zeros preserved). Configured category mode chooses an eligible dated event, supported team plus service date, or service date plus task notes. Local clocks use the installation zone, separate repeated-time occurrence choices, an explicit next-day end, and exact positive integer minutes. Gap times, future completion and dates outside the ordinary non-event window block locally; the API remains authoritative for eligibility, overlap, current zone and activity date. Every entry includes displayed `serviceDate` and `expectedTimeZone`.

Success displays the validated original receipt, its submitted notes and recorded fold choices, with the selected public service label retained separately in memory for presentation. The label never enters the API payload. No entry lookup, member history, names, private selectors, session or platform capability API is called. Correction requests are a separate submission with a message and optional receipt/activity/date claims. Receiving a correction does not change hours or approve the claim. Current staff authority never affects this anonymous page.

## Technical defaults and recovery

All fetches use `credentials: omit`, no-store and a 15-second request signal. Only public Hours endpoints and the existing public setup/branding projection are used. Branding is optional; failure falls back to LancerLogin. The theme switch is page-local and does not write storage. Shared typography, semantic surfaces, focus, spacing, radius and 44px control tokens are reused. No visual-standard exception is introduced.

Each explicit submission generates one random key, freezes its exact serialized payload in memory, and disables editing until successful receipt verification or deliberate discard. Failures never cause automatic retries. Explicit retry sends the identical bytes/key, including after an uncertain completed write. Receipt validation checks submitted date, zone, clocks, occurrences, notes, activity where known, recorded offsets and exact duration. It does not reinterpret recorded instants with current zone rules. A malformed receipt remains uncertain.

HTTP 429 uses numeric Retry-After, constrained to 1–86400 seconds (60 seconds when missing/invalid), only to disable manual actions temporarily. No timer sends a request. Generic failures disclose no provider/server error strings or competing record details. The user can discard the frozen payload, with an explicit warning that it may already have succeeded, then request a correction. Reloading or closing the page loses draft/key/receipt recovery; the interface explains this and never silently creates another submission. No member IDs, receipts, request bodies or keys enter URLs, logs, localStorage or sessionStorage.

Catalog pages retain the selected item while paging and use applied event-date filters. There is no arbitrary file/identity URL fetch or private retained-label lookup. Reloading form context explicitly clears an unsent draft and obtains fresh eligibility/zone context. Server-side scope changes remain rejection boundaries.

## Candidate verification

`npm run verify:dashboard` passed 34 JavaScript tests, 7 TypeScript tests and dashboard typecheck. Thirteen focused Playwright tests pass: all three modes, signed-in-cookie anonymous network boundary, leading zeros, original receipt/no lookup, reload limitation, frozen retry, generic conflict/correction retry, 429 without automatic retry, malformed receipt, disabled context, event paging, reopened-event DST folds/gaps, next-day/precision/future/window validation, keyboard and four visual combinations.

Screenshots were inspected at 390×844 and 1280×900 in light/dark with the standard purple/teal adopter reference. Form controls, native select arrows, focus outlines, hierarchy and mobile wrapping were checked; there is one page h1 and no horizontal overflow. Test screenshots are disposable local `test-results` artifacts, not committed. The focused fixture serves unchanged bundled fonts when this worktree's node_modules junction is outside Vite's allowed root.

The initial browser launch was blocked by local Playwright cache permissions; the authorized local runner succeeded with host process access. Its first functional run had two fixture/assertion failures: Retry-After needed cross-origin exposure in the mock server, and a DST gap locator matched both clocks. Both were corrected. Visual inspection then corrected the public form's shared CSS scope before final screenshots. The final timer-cleanup change passed its focused 429 regression. Dashboard production build also passed after an initial sandbox ancestor-directory resolution failure was retried with authorized local process access. `git diff --check` passed.

These are local browser/provider-mock results. They do not establish successful development deployment, WU-112 source assertion handling, hosted throttling, mobile Safari behavior, or a real provider interaction. No API/schema/dependency/resource changes are included.

The receipt presentation follow-up passed dashboard typecheck and four focused receipt/retry browser cases. Those checks caught a separator encoding issue in the edit transport; UTF-8 text was corrected before the passing rerun.
