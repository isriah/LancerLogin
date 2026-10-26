# Authoring a bundled module

Modules are reviewed source contributions shipped with LancerLogin. They are not runtime plugins. Start with the current `ModuleDefinition` and registry in `packages/shared/src/module-platform.ts`; Carpool is a working example of an independent module that uses Core roster identities without requiring Attendance or Outreach.

## Registration and boundaries

Declare a stable module ID, contract version, explicit dependencies, capabilities, navigation, settings, setup steps, API routes, jobs, persistence ownership, backup classification and cleanup targets. Registry validation rejects conflicting ownership and invalid declarations. Keep business logic in module-owned files; registration entries connect it to the platform. A declaration does not implement a route, job or dashboard workspace.

Use Core identities and shared provider services through their existing interfaces. Do not query another module's private tables, duplicate provider clients, or make an optional module a hidden requirement. Cross-module features need permission-scoped projections with defined behavior when the contributing module is disabled. Carpool meeting links in `apps/api/src/carpool-meeting-links.ts` demonstrate that boundary.

## Authorization and setup

Register each API path with the correct workspace, service or setup access. The Worker boundary in `apps/api/src/index.ts` resolves ownership and captures the current module generation. Use its scoped database rather than reopening an unguarded binding. `module-database-scope.ts` rechecks lifecycle and user authority around database operations, including authority changes while a request is running. A visible navigation link is not authorization.

Workspace routes need the relevant capability and completed setup. Setup routes use separate Admin authority and must validate real persisted prerequisites. Add setup predicates and a step validator to the bindings in `apps/api/src/module-platform.ts`; see `carpool-module-setup.ts`. Add dashboard setup and workspace rendering through the existing module controls, navigation and setup workspace. Follow [UI standards](UI-STANDARDS.md).

## Jobs and providers

Declare each job's stable ID and interval, and bind its implementation in `registeredModuleJobHandlers` in the Worker. The scheduler checks current enablement and captures a service database for that generation. Persist retry state and use idempotent provider operations. Recheck authority before external delivery; disabling a module must prevent new work. Shared credentials belong to the existing integration services, not module tables or browser responses.

## Persistence, backup and lifecycle

Add migrations to `apps/api/migrations`; never rewrite an applied migration. Scope module rows to their installation. Declare every owned table, any module-owned columns on shared rows, and transient authority. Classify each table as portable backup data or non-portable operational state. Update the actual backup validators and restore neutralization as well as the registry: declarations alone do not provide serialization or compatibility.

Preserve older supported backups with explicit defaults and validation. Restore must not revive stale credentials, jobs or grants. See `carpool-backup.ts`, the Worker backup adapters and [backup and restore](BACKUP-RESTORE.md).

Disabling a module retains its data for seven days while removing access. Cleanup is resumable and generation guarded. Add cleanup handling in `module-cleanup.ts` or a module-owned lifecycle file. Append steps so existing deletion cursors retain their meaning; cover shared-field reset, child ordering, interrupted retries and re-enable behavior. Do not remove another module's data. Document exactly what deletion removes.

## Reports and commands

Contribute report datasets and curated fields through the registry and their permission-scoped API projections. Validate saved definitions, query and export against the same catalog. Discord contributions use the shared command registration and dispatch boundary in `module-discord.ts`; keep provider authentication in the shared integration layer.

## Verification

Add `module-tests/<module-id>.json` using the existing manifest schema. The `fast` selection contains logic tests only. The `acceptance` selection includes relevant API/data contracts, browser behavior, typechecks and builds, including existing consumers of shared interfaces. Confirm discovery with `npm run verify:module -- list`, then run `npm run verify:module -- fast <module-id>` and the acceptance selection described in [development](DEVELOPMENT.md).

Cover Core-only operation, the module enabled independently, denied capabilities, incomplete setup, revocation during requests, disable/re-enable, cleanup retries, backup compatibility and provider failures. Use synthetic fixtures without installation credentials, attendance or biometric data. A passing mock does not establish live provider or physical kiosk acceptance. Full release gates remain separate from module development checks.
