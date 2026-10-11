# D1 usage and reporting efficiency

D1 counts rows scanned, rather than page visits or SQL query count. All databases in the same account contribute to its allowance. Production and hosted development therefore need a combined budget. Local SQLite and local Wrangler tests do not consume the hosted account allowance.

## Reporting reads

Individual attendance reports load the selected member's roster, label changes, attendance events and corrections. Meeting absence notifications load the selected meeting's events and corrections. Team reports retain the history needed for current compliance and historical reporting. Date filters must not discard earlier label assignments or the history needed by current policy calculations.

An isolate may reuse source data for at most five minutes, with a bounded number of cached scopes. Every use checks an installation-scoped database revision. Triggers advance that revision when roster, labels, rules, meetings, audiences, attendance, corrections or organization settings change, including direct SQL and category restores. Concurrent loads share a promise; failed loads and loads spanning a revision change are not retained. Separate databases never share entries. Authorization still runs on every request. Evaluated attendance results are not cached, so time-zone boundaries and late-scan cutoffs continue to update.

Migration 0037 adds lookup indexes and the operational revision table. Portable category backups exclude the revision table; restores change the revision through the ordinary domain-table triggers. Existing migrations are unchanged. Cleanup and series-operation counts use returned domain rows because D1 change counters include trigger writes.

Dashboard background refreshes pause in hidden tabs, resume when shown, and wait for each refresh to finish before scheduling the next. Manual actions retain their refresh behavior.

## Diagnostics and warnings

Expensive requests and report requests emit `d1_usage` counters to the installation's Worker logs. These contain a fixed route category, HTTP status and numeric counters only. They contain no query text, query parameters, record values, member identifiers or credentials. `measuredRowsRead` and `measuredRowsWritten` cover `all`, `run` and `batch` results. Native `first()` calls do not expose D1 metadata and are counted separately as `firstQueriesUnmeasured`. These logs diagnose expensive paths; Cloudflare account analytics remain the source for the daily allowance.

From an adopter-owned private deployment environment with an analytics-read token, run:

```sh
node scripts/d1-usage-report.mjs
node scripts/d1-usage-report.mjs 2026-09-26 5000000
```

Supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through protected process environment variables. The optional arguments select a UTC date and a row-read budget. The default budget is the Free plan's five million daily reads. Paid-plan installations can choose their own operational budget.

The report groups every active database and emits `watch`, `warning` and `critical` at 50%, 75% and 90%. An installation-owned scheduler can run it periodically and notify on a threshold transition, rather than every successful check. An analytics access failure is an error, not zero usage. Analytics can lag and query-insight aggregates may not reconcile exactly with billing enforcement. Never collect raw attendance data to monitor usage.

Compare matched workloads and the same UTC time intervals before and after a release. Check query counts as well as row counts so a quiet hour is not mistaken for an efficiency improvement. Indexes also add write overhead; monitor both rows read and rows written.

Cloudflare references: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/), and [metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).
