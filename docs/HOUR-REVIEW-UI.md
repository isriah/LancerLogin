# Hour correction review and reports (WU-109)

Dependencies: WU-105 private review/report API, WU-106 entry workspace, WU-100 named catalogs and WU-101 civil-time service. The existing capability-gated Hour Tracking workspace adds Corrections and Reports alongside Catalogs, Entries and Reporting windows. All enabled accounts with `hours.manage` use the same UI; no core roster access is granted.

## Correction review

Inbox status/member filters use bounded pages and an applied-filter snapshot. Original public claims are explicitly self-asserted and unverified even if their submitted member ID matched a roster record. Linked Discord identity is shown separately and never presented as proof of hours or approval. Claim text is rendered as React text, including receipt/activity references; it never becomes HTML, a URL or an automatic entry lookup. Original claims remain visible alongside the saved terminal resolution.

Staff explicitly find and select an entry using named roster/activity selectors and service dates. Matching pages have their own applied filters. A fresh detail read supplies the selected revision. Acknowledge and dismiss may record that reviewed entry without changing its hours; correcting and voiding require a current counted entry. Every action requires a note. Correction reuses the entry editor, its saved zone, independent fold choices, next-day calculation and displayed service-date precondition. Its correction reason becomes the resolution note; entry change and resolution use one atomic API operation. Void sends no replacement timing.

Success requires GET read-back of the terminal resolution and linked entry. Corrected fields and void-preserved fields are checked; a concurrent later revision prevents a claim of exact write confirmation. A failed, stale or uncertain response locks mutations. Explicit Reload current request performs GETs only, shows the current saved resolution or still-open request and clears stale entry selection before another action. No POST is automatically retried. Current linked entries that advanced after resolution are labeled as current, not the saved reviewed snapshot. Immutable entry history remains in Entries. No browser persistent storage or logging is added.

## Reports

Reports require explicit inclusive start/through service dates, at most 3660 dates. Grouping supports member, activity, category and primary supported team, with named filters. Global exact minutes, counted-entry count and distinct participants come directly from independent server totals; they are never computed by summing the group page. Group distinct-participant counts must not be added together. Display hours are minutes divided by 60 to two decimal places; exact minutes remain visible.

Null team is labeled No primary supported team. Partner teams do not duplicate or allocate hours. Overnight hours belong wholly to their stored start service date. Only current counted entries contribute, while voided and older history remain retained. A new explicit period can query older dates. Current roster/catalog names are labeled as current. Pages are live snapshots, not a frozen multi-page export; applied filters remain fixed for pagination/reload even while draft controls change. Failed or malformed report reads hide prior totals. No CSV or award/compliance calculation is introduced.

## Verification boundary

Focused browser scenarios use synthetic HTTP responses and real local browser rendering. They cover terminal operations/read-back, dropped response recovery without another POST, stale entry revisions, malformed responses, attribution/text safety, applied pagination, report totals, denied capability and themed keyboard/mobile layouts. They are local/mock evidence, not successful hosted acceptance or public/Discord intake testing. The API and its actual D1 verification belong to WU-105 and are unchanged here.
