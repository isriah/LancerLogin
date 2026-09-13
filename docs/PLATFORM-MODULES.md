# Platform module contract (WU-088)

Dependencies: the approved isolated development environment and settled module/grant boundaries in `plan.md`. This is the registry/configuration/grant foundation of P1, not completion of P1 or either module.

## Authorization extension to ADR-003

Admins have every capability of each enabled module. The existing attendance Operator role grants no module capability. Explicit grants are `hours.manage` and `documentation.manage`; documentation access does not require an hours management grant, but does require both modules enabled. Revoking a grant or deactivating/demoting an account takes effect on the next guarded operation.

This extends ADR-003 without changing existing attendance role checks. The current user schema still admits only Admin and Operator accounts. **A true committee staff identity with no attendance privileges is an immediate remaining P1 dependency**, to be implemented before accepting hours/domain staff UI. Do not create a disguised Operator account for a committee member.

`requireModuleCapability(db, installationId, userId, capability)` reloads the active account, role, explicit grants and configuration in one query. Call it for each protected staff operation and again when executing staff-authorized delayed work; never trust browser capabilities or session role claims. `requireModuleEnabled(db, installationId, moduleId)` guards system jobs and submission adapters, which must additionally enforce their own provider/submission/activity eligibility. Neither helper substitutes for installation-scoped domain SQL or authorization predicates in concurrent mutations.

## Routes

All routes use the existing signed session, JSON/CORS boundary and safe error handling. The deployment resolves installation `primary` server-side; clients cannot select an installation.

| Route | Access and contract |
| --- | --- |
| `GET /platform/modules` | Active staff: own effective capabilities, module metadata/enablement and configuration revision. No other users or grant inventory. |
| `PUT /admin/modules` | Admin: `{ "enabled": ["hour-tracking", "activity-documentation"], "revision": 0 }`. Full replacement; empty list means core only. |
| `GET /admin/modules/grants/:userId` | Admin: explicit grants of one active same-installation user, including grants retained while disabled. |
| `PUT /admin/modules/grants/:userId` | Admin: `{ "capabilities": ["hours.manage", "documentation.manage"] }`. Full replacement; empty list revokes explicit grants. |

Mutation bodies are bounded to 4 KiB. Unknown IDs/capabilities/fields and duplicate values fail validation. Configuration revision is optimistic concurrency control: one competing writer wins; stale writes return 409 and require reloading. The single configuration row has a database dependency constraint, so no interleaving can produce documentation-only state. The revision and enablement change, current Admin predicate and audit insertion share one D1 batch transaction. Grant writes similarly require both current active Admin and current active target in their write predicate, with an audit in the same batch. Audit failure rolls the mutation back.

The release-bundled registry declares stable IDs, dependency, capability, route-prefix ownership, navigation, settings, background-job families and backup participation. These descriptors are contracts for subsequent implementation; they do not advertise completed hours/documentation screens or start jobs. No placeholder UI or provider implementation is introduced here.

## Schema and recovery

Migration `0029_platform_modules.sql` creates `platform_module_configuration` and `platform_module_grants`. Missing configuration means both modules off and revision zero. No deployment is enabled by migration. Grants use a composite installation/user foreign key; installation deletion removes module metadata through the existing installation/user cascade.

Disable/re-enable changes only the enablement row. It preserves explicit grants, future module domain records and all existing provider credentials. Disabling hours requires explicitly excluding documentation in the same full configuration replacement. No toggle invokes external publication or backfill.

Installation backup schema 14 includes both tables, restoring users before grants. Schema 1–13 backups restore with both modules off and no grants. Invalid dependencies, duplicate grant identities, cross-installation grants and invalid flags/revisions are rejected before the destructive restore batch. Historical grants for inactive users are retained in backups but confer no access. Attendance-only backup/restore/delete continues to exclude module metadata; installation deletion includes it. Database backup does not copy Drive binaries.

D1 guarantees sequential statements and transactional rollback for batches: [Cloudflare D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). The audit uses SQLite `changes()` for the immediately preceding mutation and is tested against the local workerd/D1 runtime, not only a fake database.

## Verification and limits

- `node --test tests/platform-modules.test.mjs tests/platform-modules-d1.test.mjs`: actual SQLite migrations and HTTP/auth/backup/concurrency tests plus local workerd/D1 transaction tests.
- `npm run verify:api`: existing API regressions and API/shared typechecks.
- `npm run verify:migrations`: all 29 migrations on fresh local D1.

The standalone tests are included by both the root `npm test` glob and the focused `test:api` command. The serial WU-088 follow-up registered both files without changing dependencies or the lockfile.

These are local results. No successful development-deployment test, provider consent, domain feature, UI acceptance or updater acceptance is claimed. Staff identity expansion and the rest of P1 remain required.
