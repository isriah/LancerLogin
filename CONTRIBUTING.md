# Working on LancerLogin

This guide is for a programmer who is new to the code.
It covers setting up, running everything on your own computer, where things are, and the steps of three common changes that the code does not make obvious.

For what the product does, start with the [README](README.md).
For plugins, see [writing a plugin](docs/PLUGIN-AUTHORING.md).

## Set up

1. Install Node.js 24.22.1. This exact version is in `.node-version`, and every workflow uses it.
2. Run `npm ci --no-audit` in the repository folder.

Nothing below needs a Cloudflare account, a Raspberry Pi or a fingerprint reader.

## Run it on your computer

```sh
npm run kiosk:virtual
```

This one command starts everything, on `localhost` only:

- the Worker API, with a local database;
- the dashboard;
- one kiosk, running the real kiosk service with a simulated fingerprint reader and network;
- a control panel that shows the kiosk screen beside buttons for scanning fingers and causing faults.

The first run creates an Admin named `virtual-admin`, test members and two test meetings.
The command prints the control panel link, the dashboard link and the file that holds the Admin password.
Its data is kept in `.provision/virtual-kiosk` between runs. Add `-- --reset` to start over.
[Virtual kiosk](docs/DEVELOPMENT.md#virtual-kiosk) describes the panel and the other options.

To run the dashboard and Worker with a plugin from a folder on your computer, use `npm run plugins:dev -- --plugin <folder>`.

`npm run dev:api` and `npm run dev:dashboard` are not a working preview on their own.
`dev:api` starts the Worker with no database: `/health` reports `unconfigured` and every data route answers 503.

## Where things are

| Path | What it holds |
| --- | --- |
| `apps/api/src/index.ts` | The Worker's entry point: every Core route, in one `if`/`else` chain inside `worker.fetch` |
| `apps/api/src/worker/` | The handlers those routes call, one area per file, such as `members.ts`, `meetings.ts` and `kiosks.ts`. `core.ts` holds what they share: responses, sessions, `requireRole` and audit records |
| `apps/api/src/*.ts` | Other handlers and helpers, one area per file |
| `apps/api/migrations/` | The database schema, as numbered SQL files that are only ever added |
| `apps/dashboard/src/` | The dashboard, in React. `main.tsx` starts it, `app-shell.tsx` is the frame and navigation, `router.tsx` handles links, `dashboard-api.ts` calls the Worker |
| `apps/dashboard/src/styles.css` | The dashboard's colors, spacing, buttons, cards and form controls |
| `apps/dashboard/src/web-kiosk/` | The kiosk that runs in a browser, at `/kiosk` |
| `apps/kiosk/src/service.mjs` | The Raspberry Pi kiosk service. Plain JavaScript, no build step |
| `apps/kiosk/src/ui.mjs` | The Pi kiosk's screens, as HTML, CSS and JavaScript inside strings |
| `apps/kiosk/src/kiosk-platform.mjs` | The kiosk's hardware hooks, which the virtual kiosk replaces |
| `packages/shared/src/` | Code used by more than one app. `module-platform.ts` defines modules and declares Attendance |
| `packages/module-sdk/` | What a plugin may import |
| `scripts/` | Build, release, install and test tooling |
| `tests/` | Node tests in JavaScript (`*.test.mjs`) |
| `tests-ts/` | Node tests in TypeScript (`*.test.ts`) |
| `tests-browser/` | Playwright tests of the dashboard against a mock API, `tests/fixtures/dashboard-preview-server.mjs` |
| `tests-virtual-kiosk/` | Playwright scenarios that drive the virtual kiosk |
| `docs/` | Reference documents |
| `docs-site/` | The public documentation site |

Things that may surprise you:

- **The Worker and the dashboard share no types.** A response's type is written by hand in the dashboard. TypeScript does not notice when the two disagree.
- **There is no repository or data layer.** Handlers write SQL with `db.prepare(...)` and send related statements together with `db.batch(...)`.
- **Eight `.mjs` files in `apps/api/src` are not part of the Worker.** `worker.mjs`, `d1-repository.mjs`, `security.mjs`, `attendance-service.mjs`, `pairing-service.mjs`, `roster-import.mjs`, `integration-workflows.mjs` and `test-harness.mjs` are an early prototype that only tests import. Don't model new code on them.
- **There is no formatter or linter yet.** Match the file you are in, and don't reformat lines you aren't changing.
- **Some tests read source files as text.** `tests/dashboard-shell.test.mjs` and `tests/foundation.test.mjs` check that certain lines of code exist, character for character. Rewording such a line fails the test even when the behaviour is the same; update the test's text in the same change.

## Check your change

```sh
npm run check:quick
```

It type-checks the workspaces you touched and runs the tests that cover the files you changed, usually in under a minute.

- `npm run check:quick -- --list` shows what it would run, and why, without running it.
- `npm run check:quick -- --list --why <path>` shows which tests cover one file, and how each reaches it.

To run one test file:

```sh
node --test tests/check-quick.test.mjs
node --experimental-strip-types --test tests-ts/csv-import.test.ts
npm run test:browser -- tests-browser/dashboard-smoke.spec.ts
```

[Local development and verification](docs/DEVELOPMENT.md) lists the larger checks for each area and the release gate.

## Checklists for common changes

Each list names every place a change of that kind touches. Where a test catches a missed step, the list says which.

### Add a database column

1. **Write a new migration.** Add `apps/api/migrations/NNNN_name.sql` with the next number. Never edit an existing migration: installations have already applied it, and an update refuses a migration whose content changed.
2. **Keep the previous Worker working.** An update applies migrations before it deploys the new Worker. Add columns with a default; don't drop or rename anything the released code reads. Say in a comment at the top of the file why the previous Worker is unaffected.
3. **Record the migration's hash.** Add an entry at the end of `reviewedMigrations` in `scripts/web-upgrade-policy.json` with the file name, its SHA-256 and `"forwardCompatible": true`. This prints the hash:

   ```sh
   node -e "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');console.log(createHash('sha256').update(readFileSync(process.argv[1],'utf8').replaceAll('\r\n','\n')).digest('hex'))" apps/api/migrations/NNNN_name.sql
   ```

   `tests/web-upgrade.test.mjs` fails until the last entry matches the last migration.
4. **Decide whether the column travels in backups.** If it does, all of these are under `apps/api/src/worker/`: `tableColumns`, `backupSchemaVersion` and `backupOwnership` in `backup.ts`, and `legacyTableColumns` and `backupSourceColumns` in `restore-normalize.ts`:
   - Add the column to the **end** of its table's list in `tableColumns`. The order matters: rules for older backups drop columns by counting from the end.
   - Raise `backupSchemaVersion` by one and add a comment above it saying what the new version carries.
   - Teach the older versions that the column is absent. For the same table, add 1 to the count in every existing `slice(0, -N)` rule in `legacyTableColumns` and `backupSourceColumns`, and add a rule for backups older than the new version.
   - If the column belongs to Attendance but sits in a Core table such as `organization_settings`, add it to `sharedFields` in Attendance's definition in `packages/shared/src/module-platform.ts`, and to the version filter in `backupOwnership`.

   No test compares the migrations with `tableColumns`. A column left out is not backed up, and nothing fails.
5. **Update the tests that pin the backup version.** `tests/foundation.test.mjs` matches the `backupSchemaVersion` line and the `slice` counts as text. Several tests in `tests-ts/` assert the version number; search them for the old number. Add the column's removal for older versions to `tests-ts/fixtures/backup-versions.ts`.
6. **Reset it with its module.** If Attendance owns the column, add a step to `apps/api/src/attendance-cleanup.ts` so that **Delete attendance data** returns it to its default.
7. **Read and write it in the Worker**, then **add it to the dashboard's type** for that response by hand.
8. **Add it to the mock API** in `tests/fixtures/dashboard-preview-server.mjs` when a dashboard page reads it. Browser tests use that mock, not the Worker.
9. **Document the backup version** in `docs/BACKUP-RESTORE.md`, which has a sentence for each one.
10. **Run** `npm run verify:migrations` and `npm run check:quick`.

### Add a Worker route

1. **Add a branch to the chain** in `worker.fetch`, in `apps/api/src/index.ts`. A branch tests `url.pathname` and `request.method`. The first branch that matches wins, so put an exact path before a prefix or pattern that would also match it. Write the handler in the file for its area under `apps/api/src/worker/` and import it into `index.ts`. A file under `worker/` never imports `index.ts`.
2. **Check the role first.** Start the branch with `await requireRole(request, env, ["admin"])`, or `["admin", "operator"]`. It reads the signed-in user's current role from the database and answers 403 for any other role. A Core route has no other protection: a branch without this call is open to anyone. A kiosk route calls `kioskFor(request, env)` instead, which checks the kiosk's credential.
3. **See whether a module already owns the path.** Attendance lists its paths under `apiRoutes` in `packages/shared/src/module-platform.ts`, many of them as prefixes such as `/meetings` and `/admin/kiosks`. A request under a `workspace` entry is refused before it reaches the chain unless Attendance is enabled and the user is an Admin or Operator. If your route belongs to Attendance and no entry covers it, add one. If it does not belong to Attendance, choose a path that no entry covers.
4. **Record changes.** A route that changes data or settings writes an audit record with `writeAudit`, or adds `auditStatement` to its batch.
5. **Keep to the Cloudflare Free limits:** 10 ms of CPU and 50 database queries or outbound requests for each request. Send related statements in one `db.batch(...)`; a batch counts once. See [D1 usage](docs/D1-USAGE.md).
6. **Call it from the dashboard** with `api(...)` from `apps/dashboard/src/dashboard-api.ts`, and write the response's type by hand.
7. **Add it to the mock API** in `tests/fixtures/dashboard-preview-server.mjs` when a page calls it.
8. **Test it** by calling `worker.fetch`, as the tests in `tests-ts/` do. Include a request from a role that must be refused.

Nothing needs doing for updates: while an installation is updating, the Worker refuses every request that is not `GET`, `HEAD` or `OPTIONS`, apart from sign-in, before it reaches the chain.

### Add a control to a settings page

1. **Find the page.** Settings pages are the `*-settings.tsx` files in `apps/dashboard/src`.
2. **Use the shared styles.** A button gets `ui-button`, plus `ui-button--primary` for the one main action in its section or `ui-button--danger` for a destructive one. [UI standards](docs/UI-STANDARDS.md) has the rest.
3. **Update the control count.** `tests-ts/ui-control-inventory.test.ts` counts every `<button>`, `<input>`, `<select>`, `<textarea>` and `<summary>` in each `.tsx` file directly under `apps/dashboard/src`. Change the file's entry in `reviewedNativeControls` to the new count. Until you do, the test fails with "Native control markup changed".
4. **Check the source-text tests.** Run `npm run check:quick`. If `tests/dashboard-shell.test.mjs` fails, it matched a line you changed; update its text.
5. **Store the value.** A new setting usually needs a column and a route: follow the two lists above.
6. **Look at it** in light and dark themes, at desktop and phone widths, and with the keyboard alone.
7. **Add a browser test** for the behaviour in `tests-browser/`, and add a new spec file to `tests-browser/groups.json`.
8. **Document it** in [the dashboard reference](docs/DASHBOARD.md) when Admins or Operators will see it.
