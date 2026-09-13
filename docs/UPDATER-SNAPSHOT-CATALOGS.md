# Reviewed snapshot catalog selection

WU186 adds schema-46 capture and independent replay validation alongside the unchanged schema-49 default. It does not enable migration, application restoration or a hosted runtime.

Both createSnapshotCapture and createSnapshotReplay accept optional constructor catalogKey. Omission selects schema-49-v1; schema-46-v1 selects the reviewed older catalog. selectSnapshotCatalog recognizes only these literal labels and returns detached copies of the compiled catalog, exact digest and matching replay plan. No request or snapshot can inject a catalog, SQL or import path.

Capture checks live closed-epoch authority schema and full ordered migration ledger against the selection on every advance. Live schema objects and native ledger names must match exactly. Persisted identity contains the catalog digest; continuation and describe/readPage reject a different selection. Replay checks its selected catalog digest, chain digest, schema and source pins against the sealed manifest before target mutation. Typed codecs, byte limits, encrypted sealing and durable receipt reconciliation are unchanged.

Schema46 has 94 tables and 261 objects. Catalog SHA-256: 6717ba8219ac9485f5eb67f738b1452c13e4e5103681d66c90c426dd6f8d0b31. Chain SHA-256: 47fef5532a9d63f3f7b1715ebac013289cf22cac0a39540fac90ee31c493fe05. Existing schema49 generated artifact bytes and digests are unchanged.

## Generation

Run node scripts/generate-snapshot-catalog.mjs --schema 46, then node scripts/generate-snapshot-replay-plan.mjs --schema 46. Only 46 and 49 are accepted; omission retains 49. Generation executes the exact trusted local migration prefix on an empty local SQLite database and adds reviewed Wrangler native-ledger DDL. No installation data is read. Separate generated46 modules preserve existing49 compatibility.

Each plan derives from its own catalog foreign-key graph, rejects cycles/self references, and requires members/users parent uniqueness indexes before row insertion. Replay keeps foreign keys enabled, creates remaining indexes/triggers after data, preserves sqlite_sequence, and checks exact schema, typed pages, native ledger and integrity. It does not reuse schema49 ordering for46.

## Verification and limits

node --test tests/updater-snapshot-schema46.test.mjs exercises local Miniflare D1 with the complete schema46 catalog and populated operational grants/admission/audit rows, composite foreign keys, int64 limits, REAL, NUL text, BLOB and sequence values. Full replay survives a lost batch acknowledgment without duplicate dispatch. Wrong/default49 selection, mismatched chain and non-allowlisted keys fail closed. Populated documentation-history preservation is not covered by this fixture.

WU184 backup composition and WU183 orchestration remain49-only. General 46-to-49 admission, signed migration integration, intermediate47/48 resume handling and application restoration require separate work. A replay receipt proves reconstruction in an independent validation database, not restoration into the application. No hosted resources, runtime bindings or production data were touched.
