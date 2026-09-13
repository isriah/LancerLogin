# Signed migration transport

WU180 supplies an independently composable application-D1 binding transport. It does not configure bindings, wire the updater engine, establish a write fence, verify backups or enable incompatible updates. Its initial supported range is an exact next migration from schema 46 through schema 49.

## Trusted composition and authority

`createMigrationTransport({ pins, database, store, verifier, withClosedEpoch })` requires:

- Fixed `installationId`, `applicationDatabaseId` and distinct `updaterDatabaseId` pins. `database` must be the actual application-D1 binding supplied by trusted bootstrap; JavaScript binding objects do not themselves expose an independently verifiable database UUID. Bootstrap must verify its binding configuration. `store` is the existing encrypted artifact/operation store on separate updater D1.
- The production application verifier. `verifyRelease(manifestBytes, signatureBytes)` returns a transport-owned verified handle. Both mutation and reconciliation require that handle and reverify the exact signed migration bytes.
- A trusted `withClosedEpoch(request, callback)` implementation. It invokes the callback with an immutable authority tuple containing installation, current job/operation, manifest digest, positive closed epoch, current schema/digest ledger and `backupVerified: true`. **It must durably retain exclusive migration ownership and prevent reopening across dispatch and unresolved reconciliation. A one-time state read, in-process mutex or callback promise alone is insufficient.** This implementation remains a bootstrap/orchestration dependency; the transport does not claim to implement it.

`applyMigration({ operationId, release, migrationId, bytes })` and `reconcileMigration(sameRequest)` expose only bounded `unknown` or `applied` outcomes. Applied receipts contain `{ id, sha256, fromSchema, toSchema }`, matching the existing engine contract. No external SQL, credentials, provider errors or application data are returned.

## Atomic dispatch and readback

Within closed-epoch authority, the transport requires the exact ordered native migration-name prefix and the complete matching signed digest prefix from updater state. It persists an encrypted operation claim binding installation/database IDs, job, epoch, operation, release digest and migration identity before dispatch.

One `D1Database.batch()` contains a native-ledger guard insertion followed by every migration statement. The insertion checks the complete ordered prefix again inside the transaction and deliberately raises a JSON parse error if it differs. This works with Wrangler's nullable `name TEXT UNIQUE` column; it does not rely on a nonexistent NOT NULL constraint. Native ledger insertion, schema changes and data changes therefore commit or roll back together. Cloudflare explicitly documents rollback for binding batches; the implementation does not infer that guarantee from REST `/query` batch support or use `exec()`. See [D1 binding batch](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Readback must exactly equal the former prefix plus the expected migration name. The native ledger stores names, not hashes: the digest assertion comes from verified signed bytes and the durable dispatch claim under exclusive authority. A pre-existing next name without this claim is rejected; it is never adopted as this operation. A different epoch/job/release cannot adopt an old claim. External writers that bypass maintenance violate the required exclusive-authority contract.

After a timeout, rejection or lost acknowledgment, an existing claim permits readback only. Even an absent native row does not cause redispatch: the original batch might still be pending. A definitive rollback currently remains unknown and requires coordinator/operator resolution. No partial migration checkpoint exists. Primary-first sessions are used when available for ledger reads and batches. An injected adapter without `withSession` is supported only when it is primary-only, as in the local fixture; a replica-capable adapter must implement primary-first reads.

## SQL boundary and bounds

The portable lexer preserves original statement text and handles comments, quoted strings/identifiers, trigger bodies and nested trigger CASE expressions. SQLite validates grammar in the atomic batch. It is a restricted boundary lexer, not a general SQL authorization engine. Top-level transaction control, attach/detach, virtual/temp objects, unsupported statement kinds, native/updater metadata references and unsupported PRAGMAs fail before dispatch. Only `PRAGMA defer_foreign_keys=ON` is allowed. Signed SQL is not rewritten. Historic `foreign_keys=OFF` migrations 0014/0018 are outside the supported range; [D1 foreign-key semantics](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) require separate compatibility evidence for those upgrades.

Limits are 128 KiB per migration, 100,000 bytes per statement, 36 migration statements plus one guard, and at most 255 native ledger rows read (more than 254 rejects). Reviewed migrations 0047, 0048 and 0049 contain 32, 36 and 3 statements respectively. The transport itself uses at most 42 D1 statements on initial dispatch, including separate updater operation reads/claim; authority composition must reserve its remaining invocation budget and account for any other work. It cannot split a migration to bypass atomicity or limits.

These limits bound statements and ledger results, **not rows scanned or rewritten by arbitrary signed SQL**. Table rebuilds 0047/0048 can touch substantial installation data. Production admission still requires a dataset/cost policy and verified-backup evidence under the retained write fence; this unit does not assert a universal row-work limit from SQL byte size.

## Focused local evidence

The nullable native-name fixture matches the inspected Wrangler **4.127.1** `getCreateMigrationsTableQuery` implementation at `development/LancerLogin-modular-dev/node_modules/wrangler/wrangler-dist/cli.js`, lines 351665-351671, relative to the workspace root. The version was read from that same package's `package.json`; it is not an assumption about every worktree or future dependency version.

Run `node --test tests/updater-migrations.test.mjs` using existing Miniflare/Wrangler dependencies. Actual local D1 tests prove transactional DDL/data/native-ledger rollback, preserved trigger behavior, lost acknowledgment with zero redispatch, signature-byte/order/authority/native-prefix rejection, and no adoption of a duplicate native name. A binding hook changes the native prefix after preflight and verifies that the atomic guard prevents migration DDL/data and ledger insertion. The fixture's query counter measures the application binding only; the 42-statement composition estimate above separately includes updater-store calls and excludes the injected authority's budget. Lexer tests compare statement counts for actual reviewed 0047-0049 against the existing Wrangler splitter and cover unsupported controls and bounds. They do not prove a full populated installation upgrade or a hosted deployment. No cloud resource or runtime environment configuration is changed.
