# Writing a LancerLogin plugin

A plugin is a git repository that adds one module to LancerLogin Modular. An installation pins it to an exact commit, and LancerLogin composes it into that installation's own Worker and dashboard build. This guide takes a plugin from an empty repository to a release. [Module authoring](MODULE-AUTHORING.md) is the complete reference for the module contract, and [module plugins](MODULE-PLUGINS.md) explains how Administrators select, update and remove plugins.

Start from the template repository, [isriah/lancerlogin-plugin-template](https://github.com/isriah/lancerlogin-plugin-template). It contains a minimal Example Module (module ID `example-module`, table prefix `example_module_`) with a manifest, Worker and dashboard entries, one reviewed migration, unit tests, a release workflow and CI that verifies every commit against a public LancerLogin release; its README lists what to rename first. Two real plugins follow the same rules: the official Outreach plugin ([isriah/lancerlogin-outreach](https://github.com/isriah/lancerlogin-outreach)) and the Carpool plugin ([isriah/lancerlogin-carpool](https://github.com/isriah/lancerlogin-carpool)). Core's synthetic test plugin, `tests/fixtures/module-plugins/example`, uses every contribution point in a few small files.

## Trust model

A plugin is fully trusted code with the same access as LancerLogin itself: it runs inside the installation's Worker and dashboard, with read and write access to the installation's database and the network. Core gives plugin code a module-scoped database and withholds the Worker environment and Core secrets, and composition refuses imports of Core internals and of `cloudflare:` modules, but none of this is a sandbox. Composition imports your manifest and API entries in a child process to check them; that child has no credentials in its environment but runs as the same operating system user as the installation's deployment workflow, which holds its Cloudflare and GitHub credentials. Administrators install only plugins whose source they trust, at a commit they have reviewed. An installation can restrict which sources may be selected with `lancerlogin.plugin-sources.json` in its private deployment repository (see [allowed plugin sources](MODULE-PLUGINS.md#allowed-plugin-sources)). Write your plugin so that a reviewer can read it.

## Repository layout

```text
package.json          "type": "module", the "lancerlogin" field and peer dependencies
package-lock.json     required only when the plugin has runtime dependencies
src/manifest.ts       default export: the module definition
src/api.ts            default export: the Worker contribution
src/dashboard.tsx     default export: the dashboard contribution (optional)
migrations/           0001_name.sql ... and reviewed.json (optional)
```

The repository root is the plugin root. Composition refuses symbolic links and submodules, and every entry path must stay inside the plugin.

```json
{
  "name": "lancerlogin-module-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "lancerlogin": {
    "moduleId": "example",
    "contract": 1,
    "core": ">=2.0.0-beta.12 <3.0.0",
    "tablePrefix": "example_",
    "entries": { "manifest": "./src/manifest.ts", "api": "./src/api.ts", "dashboard": "./src/dashboard.tsx" },
    "migrations": "./migrations",
    "adoptedCoreMigrations": []
  },
  "peerDependencies": {
    "@lancerlogin/module-sdk": "^1.0.0",
    "react": "^19.1.1"
  }
}
```

- `moduleId` is lowercase letters, digits and single hyphens, and never changes once installations use it. It must not be a first-party module ID (`attendance`) or another installed plugin's ID.
- `contract` is the module contract major, which is also the major version of `@lancerlogin/module-sdk`. Core 2.x implements contract 1.
- `core` is the range of LancerLogin releases the plugin supports: space-separated `>=`, `>`, `<=`, `<` or `=` comparators, with `||` between alternatives. Composition refuses the plugin for a Core outside it, before an installation build or web update starts. As in npm, a beta Core matches only when a comparator names a beta of the same `X.Y.Z`: `>=2.0.0-beta.12 <3.0.0` accepts 2.0.0-beta.12, later 2.0.0 betas and every stable 2.x release, but not a 2.1.0 beta.
- `tablePrefix` names every table, index and trigger the plugin owns. It ends in `_` and must not overlap a Core prefix or another module's.
- `entries.manifest` and `entries.api` are required (`.ts`, `.js` or `.mjs`); `entries.dashboard` is optional (`.tsx`, `.ts`, `.jsx`, `.js` or `.mjs`).
- **Peer dependencies.** Declare `@lancerlogin/module-sdk`, `react` and, for maps, `leaflet` as `peerDependencies`. They are never installed for the plugin: the composed build uses Core's single copy, and composition refuses a peer that Core does not provide or whose installed version is outside your range.
- **Other dependencies.** Put any other runtime package in `dependencies` and commit `package-lock.json`. Composition runs `npm ci` with install scripts disabled and without development or peer dependencies. Development dependencies, such as TypeScript or test tools, are for your own repository only: composition refuses an import of a `devDependencies`-only package from any file reachable from your entries through relative imports. Your tests and release scripts, which the entries do not import, may use them.
- **Imports.** Plugin code imports only its own files, declared dependencies, `node:` built-ins and `@lancerlogin/module-sdk` (with its `/api` and `/dashboard` entry points). Imports of Core source, other `@lancerlogin/*` packages, `cloudflare:` modules (such as `cloudflare:workers`, which exposes the Worker environment and its secrets), URLs, absolute paths and `#` specifiers are refused, as are dynamic `import()` or `require()` calls without a string literal and `tsconfig` path remapping. Use the services and module settings the SDK provides instead of Worker bindings.

## Manifest

The manifest declares everything Core needs to know before any plugin code runs. Its `id`, `contractVersion` and `tablePrefix` must equal the package values, and it must be `available`.

```ts
import { defineModuleManifest } from "@lancerlogin/module-sdk";

export default defineModuleManifest({
  id: "example",
  label: "Example",
  description: "Track Example items.",
  contractVersion: 1,
  available: true,
  dependencies: [],
  capabilities: [{ id: "example.manage", label: "Manage Example", operator: true }],
  navigation: [{ label: "Example", path: "/example" }],
  settings: [{ label: "Example", path: "/settings/example" }],
  setup: { version: 1, steps: [{ id: "catalog", label: "First Example item", required: true }] },
  jobs: [{ id: "example.digest", interval: 300_000, label: "Example digest" }],
  discordCommands: [],
  apiRoutes: [
    { path: "/admin/example", match: "prefix", access: "workspace" },
    { path: "/public/example", match: "prefix", access: "service" },
    { path: "/module-setup/example", match: "prefix", access: "setup" },
  ],
  tablePrefix: "example_",
  persistence: { tables: ["example_items"], sharedFields: [], transientAuthority: [] },
  backup: { version: 1, tables: ["example_items"] },
  lifecycle: { cleanupTargets: ["example_items", "platform_module_setup_progress:example", "platform_module_assignments:example"] },
  deletedData: ["Example items"],
});
```

Core's registry rejects conflicting IDs, capabilities, routes, dashboard paths, Discord commands, report datasets, interfaces, tables and table prefixes, so a plugin that clashes with another installed module is refused before the build. Report datasets, report filters, Discord commands and walkthroughs are described in [module authoring](MODULE-AUTHORING.md#manifest).

### Calling other modules

From SDK 1.1.0 (declare `@lancerlogin/module-sdk` `^1.1.0`), a plugin can offer Worker calls to other modules and call theirs, instead of reading their tables. A provider declares `interfaces`, each namespaced by its module ID with a whole-number version and operations; every operation names the provider capability a signed-in caller needs, a plain-language label Admins read, and whether it is `grantable` to another module. A consumer declares `uses` with the interface, version, the operations it calls, whether it is `required` and a `reason` shown to Admins:

```ts
uses: [{ interface: "example.items", version: 1, operations: ["list"], required: false, reason: "Show Example items beside each run" }],
```

A required use behaves like a dependency: composition refuses the plugin without a provider that offers that version and every listed operation, and it can be enabled only with the provider. An optional use may be missing. Calls are available only while both modules are enabled and the provider is set up, and only with the signed-in user's own access to the provider or a grant an Admin gives the consumer in **Settings > Modules**. See [cross-module calls](MODULE-AUTHORING.md#cross-module-calls) for the full rules.

### Permissions and navigation

- **Routes.** A plugin's API routes are exact or prefix routes under its own name: `/admin/<module>` with `workspace` access (signed-in users), `/public/<module>` with `service` access (no sign-in; the module must be enabled) and `/module-setup/<module>` with `setup` access. The name is the module ID, or the table prefix without its final `_` and with hyphens for underscores.
- **Roles.** Admins can use every module. Operators use a module only when an Admin assigns it to them, and receive the capabilities marked `operator: true`. A navigation link is not authorization: in each handler, call `requireRole(["admin"])` or `requireRole(["admin", "operator"])` for anything narrower than the route's access, and `requireDashboardOrigin(message)` before a state change from the dashboard.
- **Navigation and settings.** `navigation` paths appear in the workspace menu while the module is enabled and set up. `settings` paths appear under **Settings**; they are Admin-only unless the dashboard page is marked `operator: true`. Dashboard paths must not be used by Core or another module.

### Settings and setup steps

Each setup step needs a persisted prerequisite. In the Worker contribution, `setup.predicates[stepId]` returns an SQL predicate Core evaluates for the setup checklist, and `setup.stepValid(db, stepId)` confirms the step against the database. In the dashboard contribution, `setup` is the component shown until the required steps are complete; it receives the module snapshot, `navigate` and `onReady`. Store settings in the plugin's own tables, behind the settings page and its own `/admin/<module>` routes. Secrets such as provider API keys are encrypted with `services.credentials` and stored only as ciphertext in the plugin's tables; plugins never read deployment variables.

## Worker contribution

```ts
import { defineApiModule } from "@lancerlogin/module-sdk/api";

const installationId = "primary";

export default defineApiModule({
  moduleId: "example",
  routes: {
    "/admin/example": async (context) => {
      if (context.url.pathname !== "/admin/example/items") return undefined;
      await context.requireRole(["admin", "operator"]);
      const result = await context.db.prepare("SELECT id, title FROM example_items WHERE installation_id = ? ORDER BY title").bind(installationId).all();
      return context.respond({ items: result.results ?? [] });
    },
    "/public/example": async () => undefined,
    "/module-setup/example": async () => undefined,
  },
  setup: {
    predicates: { catalog: (installation) => ({ sql: "EXISTS (SELECT 1 FROM example_items WHERE installation_id = ?)", bindings: [installation] }) },
    stepValid: async (db, stepId) => stepId === "catalog" && Boolean(await db.prepare("SELECT 1 FROM example_items WHERE installation_id = ? LIMIT 1").bind(installationId).first()),
  },
  jobs: { "example.digest": async ({ db }) => ({ checked: true }) },
  cleanup: { steps: [{ kind: "delete", table: "example_items" }, { kind: "assignments" }] },
  backup: { version: 1, tables: { example_items: ["installation_id", "id", "title", "created_at"] } },
});
```

Provide exactly one handler for every declared route, setup step, job, report dataset, Discord command and interface operation, and nothing undeclared; Core refuses the contribution otherwise. A route handler returns `undefined` for requests in its family that it does not handle. Handlers receive `request`, `url`, the module-scoped `db`, Core `services` (shared Google Calendar, Discord and email connections, module credentials, and `services.modules` for other modules' interfaces), `requireRole`, `json`, `body`, `respond`, `requireDashboardOrigin` and `dashboardOrigin`. The database rechecks the module's lifecycle and the user's authority with every statement. Read Core data only through the SDK's projections (`listActiveRosterIdentities`, `activeRosterIdentity`, `installationTimeZone`, `createMeetingReferenceAccess`), never another module's tables. Jobs run on Core's scheduler while the module is enabled; persist retry state and keep provider operations idempotent. Optional fields such as `freshEnable` (idempotent default rows on first enablement), `reportFilters`, `rosterReferences` and `privateResponseRoutes` are covered in [module authoring](MODULE-AUTHORING.md#worker-contribution).

A provider implements its interfaces under `interfaces`, one handler per declared operation. Each handler receives the provider's own scoped `db` and `services`, the `caller` (calling module, with the signed-in `userId` or the `grantId`) and the JSON input, validates the input and returns a JSON result or throws `HttpError`, which the caller receives with the same status and message. A consumer calls `services.modules.interface(id, version)`, which returns nothing when the interface is unavailable, then `call(operation, input)`. Input and result are plain JSON of at most 64 KB. A call is not atomic with the consumer's own writes, so keep operations idempotent and call them from a job with retry state:

```ts
interfaces: {
  "example.items": { list: async ({ db }) => ({ items: await listItems(db) }) },
},
jobs: {
  "relay.sync": async ({ services }) => {
    const items = await services.modules.interface("example.items", 1);
    if (!items) return { available: false };
    return items.call("list", {});
  },
},
```

## Dashboard contribution

```tsx
import { dashboardApi, defineDashboardModule, type DashboardSetupProps } from "@lancerlogin/module-sdk/dashboard";
import "./example.css";

function Workspace() {
  return <section className="ui-card" aria-labelledby="example-title"><h1 id="example-title">Example</h1></section>;
}

function Setup({ module, onReady }: DashboardSetupProps) {
  return <section className="ui-card"><h1>Set up {module.label}</h1><button className="ui-button" onClick={onReady}>Done</button></section>;
}

export default defineDashboardModule({
  moduleId: "example",
  routes: [{ path: "/example", render: () => <Workspace /> }],
  settingsPages: [{ path: "/settings/example", render: () => <section className="ui-card"><h1>Example settings</h1></section> }],
  setup: Setup,
});
```

`routes` render every navigation path and `settingsPages` exactly the manifest's settings paths. `publicPages` render pages anyone can open without signing in at a single-segment base path, such as `/visit`, and every path below it, which `render` receives as `subpath` (see [module authoring](MODULE-AUTHORING.md#dashboard-contribution)). Call the plugin's own routes with `dashboardApi`. Import UI helpers only from the SDK (`useModalFocus`, `usePath`, `RouteLink`, `SettingsSectionNavigation`, `MonthCalendar` and the others listed in [module authoring](MODULE-AUTHORING.md#dashboard-contribution)). Core wraps plugin pages in an element with `data-module="<module id>"`; prefix every selector in the plugin stylesheet with `:where([data-module="<module id>"])` and follow [UI standards](UI-STANDARDS.md). A dashboard contribution that fails validation is left out and reported in the browser console, while Core and other modules keep working.

## Migrations

- Name files `NNNN_name.sql` with lowercase letters, digits and underscores, numbered contiguously from `0001`. List every file, in order, in `migrations/reviewed.json` with its SHA-256 over LF line endings: `[{ "name": "0001_create_example_tables.sql", "sha256": "<64 hex digits>" }]`. The directory holds nothing else.
- Migrations are forward-only. Never edit, rename or remove a released migration; add a new one. Composition refuses a file whose hash does not match `reviewed.json`, and an installation refuses a plugin whose migrations are not an exact continuation of what it already applied, so a plugin can never move to an older commit behind its applied migrations.
- A migration may create, alter and drop only the plugin's own prefixed tables, indexes and triggers. It may reference `installations`, `members`, `users` and `member_labels` by foreign key with `ON DELETE CASCADE` or `ON DELETE SET NULL`. It may not change Core tables or use PRAGMA, ATTACH, views, temporary or virtual tables. Scope every row by `installation_id`.
- The tables the migrations produce must equal the manifest's `persistence.tables`.
- **How Core applies them.** Right after first-Admin setup, before a new deployment serves its first request, and on every five-minute maintenance pass, the Worker applies each plugin's pending migrations through a per-module ledger, one atomic D1 batch per migration, and then registers a new plugin as disabled. A plugin whose migration fails stays "setup incomplete" and retries without affecting other modules.
- **Adopting existing tables.** A module that moved out of Core lists the historical Core migrations that created its tables in `adoptedCoreMigrations`, in ascending order. Each must exist in the Core release and change only tables with the plugin's prefix. The ledger records them as an adopted baseline without running SQL, and the plugin's own migrations continue from there. New plugins leave the list empty. See [moving a first-party module into a plugin](MODULE-AUTHORING.md#moving-a-first-party-module-into-a-plugin).

## Backups and restore

Entire-installation backups include each plugin's portable rows in a separate `externalModules` section with its source and commit. Declare portable tables in the manifest's `backup.tables` and operational state (leases, public submissions, stored credentials) in `backup.nonPortableTables`. The Worker contribution's `backup` adapter lists the portable tables in parent-first order with their columns and the manifest's backup version, and may add `normalize` (convert rows from older backup versions), `validate`, `neutralize` (stop transient authority, credentials, leases and pending work from reviving) and `pausedOperations`. Increase `backup.version` whenever the portable shape changes, and keep `normalize` able to read every earlier version. Restoring a backup that holds a plugin the installation does not have, or a newer backup version than the installed plugin supports, is refused until the Administrator installs the plugin or explicitly discards its data. See [backup and restore](BACKUP-RESTORE.md#plugin-modules).

## Cleanup on removal

Disabling a module removes access at once and retains its data for seven days; then Core deletes it with the plugin's cleanup steps. Declare `cleanup.steps` child-first: `delete` or `reset` for the plugin's own tables, `assignments` for its Operator assignments, and optionally `{ kind: "delete", table: "platform_module_setup_progress", where: "module_id=?", bindings: ["<module id>"] }` for its setup progress. List the same targets in the manifest's `lifecycle.cleanupTargets`, and describe what deletion removes in `deletedData`. Core records the cleanup steps when the plugin is installed, so data is still deleted if the plugin's code is removed later. Append new steps at the end; never reorder them, because deletion progress is stored by position. Add a `cleanup.blocker` when in-flight work must finish first.

## Develop locally

From a LancerLogin Core checkout that includes the local development loop (v2.0.0-beta.13 or later), with the plugin in a folder beside it:

```bash
npm ci --no-audit
npm run plugins:dev -- --plugin ../lancerlogin-example
```

The command takes a snapshot of the plugin folder, including uncommitted changes but not ignored files, commits it to a throwaway repository under `.provision/plugin-dev/`, and composes that commit with the same checks an installation build runs: package, contract and Core range, imports, peer dependencies, locked dependency install, manifest, API shape, migrations and conflicts with every other module. Core's official modules are included unless you pass `--no-official-modules`; repeat `--plugin` to compose several plugins. It then applies Core's migrations to a local D1 database under `.provision/plugin-dev/state`, starts the Worker (`wrangler dev`, default `http://localhost:8787`) and the dashboard (Vite, default `http://localhost:5173`), and prints a one-time setup code for creating the first Admin of that local database. Saving a file in the plugin folder recomposes, and both servers reload; if recomposition fails, the error is printed and the next save tries again. Plugin migrations apply as in a deployment: when the first Admin is created, and when a recomposed plugin reaches the restarted Worker. To run scheduled jobs without waiting five minutes, open `http://localhost:8787/__scheduled?cron=*/5+*+*+*+*`. `--api-port`, `--dashboard-port` and `--no-watch` adjust the defaults.

The mode is for development only:

- It refuses to run when CI or deployment variables are set (`CI`, `GITHUB_ACTIONS`, `CF_PAGES`, `WORKERS_CI`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `INSTALLATION_SLUG` and the update credentials).
- Installation builds, web updates and **Settings > Modules > Plugins** accept only `https` sources pinned to a full commit, so a local folder can never be selected there, and `npm run plugins:dev` never reads `lancerlogin.modules.json`.
- The generated module files it writes start with a `LOCAL PLUGIN DEVELOPMENT` header and are restored to their committed plugin-free defaults when the command stops. If it was killed, the next run restores them first, or run `npm run plugins:dev -- --restore`. Core's tests also fail if a composed generated file is committed.

## Test and release

- **Inspect.** Composition imports the manifest and API entries in a child process (`scripts/inspect-module-plugin.mjs`) with a minimal environment and checks their declarations; the same errors appear from `npm run plugins:dev`. Keep entry modules free of side effects at import time.
- **Unit tests.** `npm test` in the template runs the plugin's own tests, including a package check that `migrations/reviewed.json` matches the migration files.
- **Verify against Core.** `.github/plugin-release.json` names the plugin (`repository`, and the release `title` that patch notes start with) and pins the Core it is verified against: `core.repository` (`isriah/LancerLogin`), `core.commit` (the full commit SHA of the release tag) and `core.tag` (for example `v2.0.0-beta.12`, recorded for people). `scripts/verify-with-core.mjs` composes the committed plugin into a Core checkout with Core's own composer and official plugins, then typechecks the composed Worker and dashboard (`--mode fast`) and also builds them (`--mode acceptance`, the default), and always restores Core's generated files. Run it locally with `npm run verify:core -- ../LancerLogin` from a clean commit, beside a Core checkout at the pinned commit with `npm ci` done; CI refuses any other Core commit.
- **CI.** **Verify** (`.github/workflows/ci.yml`) runs on pushes to `main`, pull requests and on demand: actionlint, `npm ci` and `npm test` in the plugin, then the pinned public Core checkout, `npm ci` and `verify-with-core.mjs --mode acceptance`. Core and the official plugins are public, so no secret is needed; `LANCERLOGIN_CORE_TOKEN` and `LANCERLOGIN_PLUGIN_TOKEN` are optional and used only for a private Core or private plugins. Raise `core.commit` and `core.tag` in their own pull request, and widen `lancerlogin.core` only after Verify passes against that release.
- **Releases.** Enable immutable releases in the repository settings first; installations accept only published, immutable releases. On `main`, set `package.json` `version` (`X.Y.Z` or `X.Y.Z-beta.N`), add `docs/releases/vX.Y.Z.md` (title `# <title> vX.Y.Z`, a short summary, then **Bugs fixed**, **Features added** and **Features removed**) and a `CHANGELOG.md` entry, and commit them as `Release vX.Y.Z`. When Verify has passed for that exact commit, push the tag `vX.Y.Z`. **Release plugin** (`.github/workflows/release.yml`) checks the version, notes, changelog and release commit, requires that Verify run and prepares a draft release. Publish it from your own checkout with `node scripts/plugin-release.mjs publish vX.Y.Z`, then again with `--publish`; beta releases become prereleases. Never move or reuse a tag or replace a published release. **Nightly plugin build** (`.github/workflows/nightly.yml`) publishes testing-only `vX.Y.Z-nightly.YYYYMMDD` prereleases from `main` when it has verified commits that are in no release.
- **Tracks and pins.** Installations never pin a tag. An Administrator chooses a release in **Settings > Modules > Plugins** on the **Stable** or **Nightly (testing only)** track, or a maintainer runs `npm run plugins:resolve -- --selection lancerlogin.modules.json --track stable`; both resolve the newest published, immutable release on the track to its full commit SHA and pin that. Release lookup works for `https://github.com/<owner>/<repository>.git` sources. State the supported Core range in your README.
