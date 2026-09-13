# D1 migration transport compatibility

WU-108 replaces three conditional trigger statements in migration 0033 with equivalent `SELECT RAISE(ABORT, ...) WHERE EXISTS (...)` predicates. The overlap INSERT/UPDATE and activity-date history conditions are unchanged, including installation scope, half-open interval comparisons and prior-revision references. The triggers still abort their enclosing transaction.

## Evidence and boundary

Pinned Wrangler 4.127.1 correctly recognizes both BEGIN and CASE nesting in its exported `unstable_splitSqlQuery`. The original 0033 produces 16 complete statements and applies successfully to local SQLite. This was not a Wrangler local splitter defect.

Wrangler's local migration path splits SQL and uses a D1 batch. Its remote migration path instead sends the entire normalized migration plus the migration-ledger INSERT to D1's query endpoint. The maintainer's authorized, read-only hosted `EXPLAIN CREATE TRIGGER` probes isolated the difference: a synthetic `BEGIN SELECT CASE WHEN 1 THEN RAISE(ABORT,'synthetic') END; END;` body returned HTTP 400 / SQLite 7500 incomplete input; the equivalent `BEGIN SELECT RAISE(ABORT,'synthetic') WHERE 1; END;` body succeeded. EXPLAIN created no trigger. No credentials, account identifiers or private query records belong in this document.

Local fixtures now use the actual pinned Wrangler splitter, rather than a separate test parser, for the accounting migration and its prerequisites. Node SQLite validates the resulting complete statements; the existing real local Miniflare D1 accounting tests validate the preserved behavior. A focused assertion excludes the evidenced incompatible CASE form from these trigger bodies. These local checks cannot emulate the hosted parser or substitute for coordinator-run hosted migration acceptance.

## Why rewriting 0033 is safe here

Before each of the three failed development attempts, the maintainer reconciled the migration ledger at 32 and confirmed no accounting schema objects existed. Migration 0033 has never successfully applied to the hosted development database. Prior local applications were disposable test databases. Production was never targeted. Consequently this narrowly corrected, unapplied migration retains its number; no successful deployed migration history is rewritten. The maintainer retains the failed-attempt records and must verify the hosted ledger, all five tables, six triggers and accounting behavior after retry.

Future trigger migrations must avoid this evidenced CASE-inside-trigger form, or first demonstrate acceptance using an authorized read-only hosted EXPLAIN. A successful local split or SQLite execution alone is insufficient. No dependency upgrade, generic SQL parser, production mutation or remote retry is part of WU-108.

Candidate verification: `node --test tests/hour-accounting-d1.test.mjs` passed both tests (Node SQLite transport regression and real local D1 accounting transaction coverage); `npm run verify:migrations` passed all 33 migrations on a fresh disposable local database. `git diff --check` passed. These are local candidate results, not hosted acceptance.
