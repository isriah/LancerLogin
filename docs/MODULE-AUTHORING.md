# Authoring a module

A module is either first-party, shipped in this repository, or a plugin: a separate git repository that an installation selects and composes into its own build. Both implement the same contract. This guide covers plugins first; first-party differences are noted at the end. Installations select plugins as described in [module plugins](MODULE-PLUGINS.md). For a step-by-step path from a new repository to a release, including the local development loop and the template repository, see [writing a plugin](PLUGIN-AUTHORING.md).

Plugins import only `@lancerlogin/module-sdk`. Composition refuses imports of Core source, other `@lancerlogin/*` packages, or relative paths that leave the plugin.

## Package layout

```text
package.json          "type": "module" and a "lancerlogin" field
src/manifest.ts       default export: the module definition
src/api.ts            default export: the Worker contribution
src/dashboard.tsx     default export: the dashboard contribution (optional)
migrations/           NNNN_name.sql files and reviewed.json (optional)
```

```json
"lancerlogin": {
  "moduleId": "example",
  "contract": 1,
  "core": ">=2.0.0 <3.0.0",
  "tablePrefix": "example_",
  "entries": { "manifest": "./src/manifest.ts", "api": "./src/api.ts", "dashboard": "./src/dashboard.tsx" },
  "migrations": "./migrations",
  "adoptedCoreMigrations": []
}
```

`contract` is the module contract major and the SDK major. `core` is a version range checked against the Core release. The manifest's `id`, `contractVersion` and `tablePrefix` must match the package. Declare React, Leaflet and `@lancerlogin/module-sdk` as `peerDependencies`: they always resolve to Core's single copy, are never installed for the plugin, and must be within the declared range of the versions Core provides. Declare any other runtime package in `dependencies`, with a lockfile; composition installs them with install scripts disabled and without development or peer dependencies.

The reference plugins are the synthetic `tests/fixtures/module-plugins/example` and the Carpool plugin, which is maintained in its own repository. Core's Carpool tests compose the Carpool plugin from the pin in `tests/fixtures/carpool.modules.json` (see `tests-ts/fixtures/carpool-plugin.ts`).

## Manifest

Declare a stable module ID, contract version, explicit dependencies, capabilities, navigation, settings, setup steps, API routes, jobs, Discord commands, report datasets, persistence ownership, backup classification and cleanup targets. Use `defineModuleManifest` from `@lancerlogin/module-sdk` for type checking. The registry rejects conflicting IDs, capabilities, routes, commands, datasets, tables and table prefixes.

Plugin routes live under `/admin/<module>`, `/public/<module>` and `/module-setup/<module>`, for workspace, service and setup access respectively. Pattern routes are reserved for first-party modules.

## Worker contribution

Implement the manifest with an `ApiModuleContribution` from `@lancerlogin/module-sdk/api`, using `defineApiModule`. The Worker refuses to load a contribution that does not provide exactly one handler for every declared route, setup step, job, report dataset and Discord command, or that provides anything undeclared. Composition applies the same check before a build.

- **Routes.** Handlers are keyed by declared route path. The Worker resolves ownership, admits the request with the right authority, captures the current module generation, and calls the handler with a context: `request`, `url`, a module-scoped `db`, Core `services`, `requireRole`, `json`, `body`, `respond`, `requireDashboardOrigin` and `dashboardOrigin` (the installation's dashboard origin, for checking where a public form was submitted from). Return `undefined` for requests in the family you do not handle. A navigation link is not authorization; call `requireRole` for anything narrower than the route's access.
- **Database.** Use the context database. It rechecks module lifecycle and user authority in the same transaction as every statement, including authority changes while a request runs. Do not query another module's tables.
- **Services.** `services.googleCalendar` and `services.discord` use the installation's shared connections. `services.credentials` encrypts module-owned secrets with Core's key; store only the ciphertext in your own table. Plugins never receive the Worker environment or Core secrets.
- **Core projections.** `listActiveRosterIdentities`, `activeRosterIdentity` and `createMeetingReferenceAccess` (which returns nothing when Attendance is unavailable) take the context database. A meeting reference's `withTarget` accepts the module's own message for a meeting that is no longer available.
- **Shared helpers.** `@lancerlogin/module-sdk` exports the civil-time helpers (`instantToCivil`, `resolveCivilTime`, `selectCivilTime`, `addCalendarDays`, `elapsedIntegerMinutes`, `CivilTimeError` and their types) for code that runs in both the Worker and the dashboard, the `ModuleSnapshotItem` type, and the report field helpers `reportFilterOperators` and `coreMemberReportFieldDefinitions` for manifests.
- **Setup.** Provide a predicate and a validator for every setup step. Predicates must check real persisted prerequisites.
- **Jobs.** Bind each declared job. The scheduler checks enablement and passes a service-scoped database. Persist retry state and use idempotent provider operations.
- **Reports and Discord.** Bind each declared dataset and command. Validate saved definitions against the same catalog you declare. Member-level datasets (row identity `core.member.identity`) reuse `coreMemberReportFieldDefinitions()` and build rows with the SDK's `reportRosterData`, `reportMemberValues`, `reportMemberIncluded`, `reportRow` and `filterAndSortReportRows`. A dataset can map former field IDs that saved reports still use to current ones with `fieldAliases`.
- **Report filters.** Besides Core's filters (`period`, `roster`, `meeting-type`, `labels`, `membership`), a module can declare `reportFilters`: option sets such as its own labels, matched any or all. A filter ID is namespaced by the first segment of one of the module's dataset IDs (`outreach-labels` for `outreach.*` datasets). Saved definitions store the selection under the filter's `selectionKey` and `matchKey`, so these never change once reports are saved. Provide `reportFilters` handlers on the API contribution whose `options(db)` lists every option, archived ones included; Core validates saved selections against them and the dashboard renders the filter. Apply the selection in your own projections with `reportFilterSelection(definition, filterId)`.
- **Roster references.** Declare `rosterReferences` (a label and the module columns that hold member IDs) so Core refuses to delete a member, or the whole roster, while your history still refers to it.
- **Seeds.** Plugins create default rows in `freshEnable`, which runs in the same batch as first enablement and as enablement after completed deletion. Make it idempotent. Installation seeds are first-party only.
- **Private responses.** List public route paths whose responses must not be cached or indexed in `privateResponseRoutes`.
- **Jobs and walkthroughs in the manifest.** A job may carry a `label` for scheduler controls. Declare page walkthroughs in `walkthroughs` (page ID, content version and step IDs) so Core stores each account's progress.

## Dashboard contribution

Default-export a `DashboardModuleContribution` from `@lancerlogin/module-sdk/dashboard`, using `defineDashboardModule`. Declare React as a peer dependency so the plugin shares the dashboard's React.

- **Pages.** `routes` render every declared navigation path (`:name` segments, and a final `:name+` for the rest of a path). `settingsPages` render exactly the manifest's settings paths; they are Admin-only unless marked `operator`. Pages appear only while the module is workspace-ready, and they resolve after Core pages, so a module cannot replace a Core page.
- **Setup.** Provide a `setup` component when the manifest declares setup steps. It receives the module snapshot, `navigate` and `onReady`.
- **Walkthroughs.** Attach walkthroughs to the module's own route paths, using page IDs the manifest declares in `walkthroughs`.
- **Public pages.** `publicPages` render pages anyone can open without signing in, such as a submission form, at an exact single-segment path outside Core's pages and every module's navigation. Core renders them with the installation's branding header and a skip link labelled by `skipLinkLabel`. They should call only the module's `service` routes, which enforce enablement.
- **Slots.** Host pages offer named slots, such as Attendance meeting badges and the meeting detail panel. A `slotData` hook runs once for the region a data slot wraps; badge and panel components read its result with `useModuleSlotData`, so items never trigger their own requests. A slot renders only while both the host and the contributing module are workspace-ready.
- **Styles.** Core wraps every module page, setup screen and slot in a `module-root` element with `data-module="<module id>"` and no layout box. Import the module stylesheet only from the contribution, prefix every selector with `:where([data-module="<module id>"])`, and prefix keyframes with the module ID. Follow [UI standards](UI-STANDARDS.md).
- **API calls.** Use `dashboardApi` for the module's own routes, and `dashboardApiBaseUrl` where a request must be built by hand.
- **Core UI behavior.** `useModalFocus` (dialog focus and Escape), `usePath`, `RouteLink` and `routeWillChangeEvent` (in-place navigation and unsaved-work guards), `SettingsSectionNavigation` with `settingsSectionHref` (sectioned settings pages, with an optional `pickerLabel` for the narrow-screen picker), and `MonthCalendar`, `CalendarViewToggle`, `PencilIcon` and `useCalendarSelection` (the meeting calendar) behave exactly as they do on Core pages. Import nothing else from the dashboard.

The dashboard validates contributions against their manifests when it loads. A plugin whose dashboard contribution is invalid is left out and reported in the browser console, while Core and every other module keep working; its Worker routes and data are unaffected.

## Persistence

Every table starts with the module's `tablePrefix`. Ship ordered `NNNN_name.sql` migrations and a `migrations/reviewed.json` listing each file's name and LF-normalized SHA-256. Never edit a reviewed migration; add a new one.

Migrations may create, alter and drop only the module's own tables, indexes and triggers. They may reference `installations`, `members`, `users` and `member_labels` by foreign key with `ON DELETE CASCADE` or `ON DELETE SET NULL`. Plugins never add columns to Core tables. PRAGMA, ATTACH, views, temporary or virtual tables, and anything the checker does not recognize are refused.

The Worker applies pending migrations through a per-module ledger, one atomic D1 batch per migration, before it registers the module. A module whose migration fails stays "setup incomplete" and retries; it never blocks other modules. Downgrades and changed hashes are refused.

## Backup and lifecycle

Plugins with portable tables provide a `backup` adapter: the manifest's backup version, the portable tables in parent-first order with their columns, and optional `normalize(tables, fromVersion, source)` (older backup versions; `source` carries the backup schema, whether the rows came from Core's section, the export time and the installation's creation time), `validate`, `neutralize` (transient authority, credentials, leases and pending jobs must not revive) and `pausedOperations` (how many provider operations `neutralize` pauses, reported with Core's paused operations). Classify operational tables as `nonPortableTables`. Backups carry plugin rows in a separate `externalModules` section with the plugin's source and commit. See [backup and restore](BACKUP-RESTORE.md).

Disabling a module retains its data for seven days while removing access. Provide declarative cleanup steps (`delete`, `reset`, `assignments`) in child-first order and any blocker for in-flight work. Steps may target only the module's own tables, except one: `{ kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["<module id>"] }` deletes the module's own setup progress. Core records the module's definition and cleanup steps before it can be enabled, so retained data is still deleted if the plugin's code is later removed. Append steps; never reorder them, because deletion cursors persist. Document exactly what deletion removes in `deletedData`.

## Moving a first-party module into a plugin

Carpool and Outreach moved from Core into plugins. The plugin keeps the module's ID, contract version, setup version, capabilities, routes, pages, tables, cleanup targets and cleanup steps, in the same order, so lifecycle rows, Operator assignments, setup progress and interrupted deletions stay valid.

- **Schema.** List the historical Core migrations that created the module's tables in `adoptedCoreMigrations`. They stay in Core's sequence; the module ledger records them as an adopted baseline without running SQL. New schema changes ship only in the plugin.
- **Backups.** Increase the module backup version for the plugin section. Core backups made while the module was first-party carry its rows in Core's section; restore hands them to `normalize` with the version recorded in that file's ownership metadata and `source.coreSection` set, and `source.backupSchemaVersion` tells the adapter which Core shims apply.
- **Core's frozen record.** Add the module to `apps/api/src/extracted-modules.ts`: its historical ownership entry (including transient authority), Core-section tables with the first backup schema of each, the first backup schema without them, the catalog definition Core recorded while it was first-party, the tables whose rows every installation received (`seedTables`), its walkthrough pages and its roster references.
- **Seeds.** First-party installation seeds become idempotent `freshEnable` rows; check that a new installation receives the same rows on first enablement.
- **Core references.** Replace Core code that named the module (report filters, roster deletion checks, scheduler labels, walkthrough pages, public pages, styles) with the contribution points above. Adopted Core migrations may drop the module's own indexes and triggers. Never edit an entry. Core uses it to validate and lift historical backups and to record a removed module's cleanup when the plugin is not installed and the catalog never recorded it.
- **Environment.** Plugins receive no Worker environment, so any deployment-variable fallback the first-party module read is dropped. Document the replacement setting in the module's guide and the release notes.

## Verification

Cover Core-only operation, the module enabled independently, denied capabilities, incomplete setup, revocation during requests, disable and re-enable, cleanup retries, backup round trips and provider failures. Use synthetic data only; never installation credentials, attendance or biometric data. `tests-ts/module-plugin-worker.test.ts` shows how to compose a plugin from a local git commit and exercise it through the Worker. A passing mock does not establish live provider or physical kiosk acceptance.

## First-party modules

Attendance is the only first-party module. It registers in `apps/api/src/installed-api-modules.ts` and lives in this repository. They may use installation seeds, Core-owned columns declared as `sharedFields`, and Core-managed backups. Attendance is integrated with Core: its routes, including kiosk endpoints, stay in the Core dispatcher, and its kiosk revocation on disable remains Core behavior. Add test selections to `module-tests/<module-id>.json` and run `npm run verify:module -- fast <module-id>`; a plugin's manifest also names its test selection file in `pluginSelection`, so its browser specs, typechecks and builds run with the plugin composed. See [development](DEVELOPMENT.md).
