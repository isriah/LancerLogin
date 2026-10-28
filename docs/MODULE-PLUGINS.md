# Module plugins

A plugin adds a module to one installation without changing LancerLogin itself. It is a git repository that the installation pins to an exact commit and builds into its own deployment. Plugin authors start with [writing a plugin](PLUGIN-AUTHORING.md) and the full contract in [module authoring](MODULE-AUTHORING.md).

## Trust

A plugin is fully trusted code with the same access as LancerLogin itself. It runs inside the installation's Worker and dashboard, can read and change the installation's database, and can make network requests. LancerLogin does not review external plugins. Install only plugins whose source you trust, and pin a commit you have reviewed.

Core keeps its secrets away from plugin code by default, but none of this is a sandbox:

- **In the Worker,** Core gives plugin code no Worker environment, and composition refuses `cloudflare:` imports, because `cloudflare:workers` would expose the environment and its secrets.
- **During composition,** each plugin's manifest and API entries are imported in a child process to check them. That child gets a minimal environment with no Cloudflare, GitHub, update, plugin or other credentials, and no proxy settings. It still runs as the same operating system user as the installation or web update workflow, which holds the Cloudflare account token and other deployment secrets, so a hostile plugin could read them from the parent process or the runner. Treat selecting a plugin like giving its author access to the installation's Cloudflare deployment and private repository.

## Select plugins

Add `lancerlogin.modules.json` to the installation's private deployment repository. Without this file, the build contains the first-party modules and LancerLogin's [official modules](#official-modules).

```json
{
  "format": 1,
  "modules": [
    { "id": "example", "source": "https://github.com/owner/lancerlogin-example.git", "commit": "0123456789abcdef0123456789abcdef01234567" }
  ]
}
```

- `source` is an `https://host/owner/repository.git` URL without credentials, a port or a query string.
- `commit` is the full 40-character commit SHA. Branches, tags and shortened SHAs are refused.
- `track` is optional: the plugin's release track, `"stable"` (the default when absent) or `"nightly"` (testing only). It only decides which releases **Upgrade** and `npm run plugins:resolve` offer; composition ignores it and builds the pinned commit. Any other value is refused.
- For a private plugin repository, store a read-only token as the `LANCERLOGIN_PLUGIN_TOKEN` secret. It is passed to git only as a header for the plugin's host, and never written to files, URLs or logs. Composition sends it only to `github.com` and to hosts listed in [`lancerlogin.plugin-sources.json`](#allowed-plugin-sources); a source on any other host is fetched anonymously, so a selection cannot send the token to a host the installation has not listed.

## Manage plugins in Settings → Modules

Administrators can add, upgrade and remove plugins in **Settings → Modules → Plugins** instead of editing `lancerlogin.modules.json` by hand. This deliberately lets the dashboard choose plugin code, and nothing else: the LancerLogin release, update workflow, branch, installation slug and Cloudflare resources stay fixed.

- **The selection file stays the source of truth.** The Worker commits each change to `lancerlogin.modules.json` on `main` in the private deployment repository, with a commit message naming the change and the Admin. It writes only that file, and only if the file still has the content the Admin reviewed; a concurrent edit is refused and must be reviewed again. Without the file, the first change creates it.
- **Add or upgrade** takes the module ID, an `https://host/owner/repository.git` URL and the full 40-character commit SHA, with the same rules as the file. **Remove** deletes the module's entry. Removing the entry of an official module returns it to the commit LancerLogin pins for the release.
- **Release track.** The add and upgrade dialog has a **Release track** choice: **Stable** (default; stable releases only) or **Nightly (testing only)**, which also offers beta and nightly prereleases. Upgrade looks up the newest published, immutable release on the plugin's track and fills in its full commit SHA for review; **Find newest release** repeats the lookup. Releases are read anonymously from GitHub's public API for `github.com` sources only; for other hosts and private repositories the dialog says why and the Admin enters the reviewed commit. Choosing Nightly shows a testing-only warning, and installed plugins on Nightly carry a "Nightly track · testing only" label. The track is stored as `"track": "nightly"` on the plugin's entry; changing it, even without changing the commit, is a plugin change with the same review, trust confirmation, fresh authentication, allowlist, audit entry and commit as any other.
- **Before committing,** the dashboard shows the source and commit, the commit being replaced, compatibility with this installation's module contract and LancerLogin version, the plugin's table prefix and migrations, and the trust statement. For `github.com` sources it reads the plugin's `package.json` and migration names at that commit through GitHub's public API, without credentials and without running plugin code; for other hosts and private repositories compatibility is shown as not determined here. Routes, jobs and Discord commands are declared in plugin code and are not shown; composition checks them for conflicts before the change is applied. The Admin must confirm trust in the source and the reviewed commit. An incompatible plugin cannot be committed.
- **Safeguards.** Only an active Admin, from the exact dashboard origin, can change plugins. Each change needs fresh authentication: a sign-in, or confirming the Admin's password (or signing in with Google again) in the dialog, within the last ten minutes. Changes are refused while a web update is running and expire an update that was prepared but not started. A module's plugin cannot be removed while the module is enabled, or while its retained data is waiting to be deleted; disable it first and remove the plugin after its data is deleted. Every change is recorded in the audit log, and confirming identity is audited too.
- **Pending changes.** A committed change is not deployed. The **Pending changes** list shows what the next deployment adds, upgrades or removes, separately from the installed plugins, which are unchanged until then.
- **Apply plugin changes** deploys them with the standard update flow: back up the entire installation, confirm the file was saved, start, then follow approval, deployment and verification. It redeploys the installed LancerLogin release with the committed selection, using the same build, maintenance, checkpoint, migration, deployment and health stages as an update. The request pins the exact selection it was prepared with; if the file changes afterwards, the update stops before it claims the installation, and the request must be prepared again. A release update also deploys pending plugin changes.
- **Production approval.** The page shows whether the `production` environment of the private repository requires reviewers, or that this could not be checked. Configure required reviewers: with them, a hijacked Admin session can commit a plugin change but cannot deploy it without a reviewer's approval in GitHub.

### Plugin selection credential

Dashboard plugin management needs its own credential, separate from the web update dispatch credential. Through GitHub's secure token UI, create a fine-grained token scoped to **only the private deployment repository**, with **Contents: read and write** and default Metadata read. Save it as the production environment secret `LANCERLOGIN_MODULE_SELECTION_TOKEN`, and record its expiry as the ISO UTC environment variable `MODULE_SELECTION_TOKEN_EXPIRES_AT`. Provisioning and **Refresh web update credential** verify that it can read the private repository, that it is a different token from the dispatch credential and that it has not expired, then upload it to the Worker as `MODULE_SELECTION_TOKEN` and `MODULE_SELECTION_TOKEN_EXPIRES_AT`. A read check cannot prove write access; grant Contents write when creating the token. Do not grant the Workflows permission. Renew it as you renew the dispatch credential. Private repositories created before plugin management need `LANCERLOGIN_MODULE_SELECTION_TOKEN: ${{ secrets.LANCERLOGIN_MODULE_SELECTION_TOKEN }}` in the `env` of the step that runs `scripts/refresh-web-update-credential.mjs` in `refresh-web-update-credential.yml` and `provision-template.yml`, and `MODULE_SELECTION_TOKEN_EXPIRES_AT: ${{ vars.MODULE_SELECTION_TOKEN_EXPIRES_AT }}` in the job `env`. Current templates give every secret only to the steps that use it, so `npm ci` and the builds never receive it; copy that layout when you update the workflows. The upgrade workflow never receives it.

Without this credential, Settings lists installed plugins and plugin changes are unavailable; editing `lancerlogin.modules.json` directly keeps working. The credential is sent only to `api.github.com`, never to a plugin's host, and never appears in API responses, D1, backups or logs. When it is configured, every web update also records the selection it was prepared with.

**Scope of this credential.** GitHub cannot limit a fine-grained token to one file: Contents write lets it change any file on any branch of the private repository. The Worker's code writes only `lancerlogin.modules.json` on `main`, through GitHub's contents API at that fixed path, and never writes `lancerlogin.plugin-sources.json` or any other file. That is a property of LancerLogin's code, not of the token. Anyone who obtains the token (for example from a compromised Worker or a malicious plugin, which runs inside the Worker) could instead change the controller's scripts and `package.json`, which `refresh-web-update-credential.yml` installs and runs with the Cloudflare credential, or the allowlist. Without the Workflows permission it cannot change `.github/workflows`. To narrow it:

- Require reviewers on the `production` environment, so no deployment runs without a person's approval.
- Protect `main` with a ruleset. Where your GitHub plan offers push rulesets for private repositories, add a **Restrict file paths** rule for `.github/**`, `scripts/**`, `package.json`, `package-lock.json` and `lancerlogin.plugin-sources.json`, with only repository administrators as bypass actors. A fine-grained token acts as the account that created it, so create the selection token from an account that has write access to this repository but is not a bypass actor, such as a dedicated machine account. With this rule the token can change only files outside those paths, which in practice is `lancerlogin.modules.json`.
- Before approving a deployment or running **Refresh web update credential**, check that recent commits to `main` changed only `lancerlogin.modules.json`.

### Allowed plugin sources

To limit which plugins Admins can select, add `lancerlogin.plugin-sources.json` to the private repository. The dashboard cannot edit it.

```json
{ "format": 1, "allowedSources": ["github.com/your-organization", "git.example.org"] }
```

An entry is a host, allowing every owner on it, or `host/owner`. With the file, adding or upgrading to any other source is refused; an invalid file refuses every source until it is repaired. Without the file, any source is allowed. Every host the file lists, as well as `github.com`, receives `LANCERLOGIN_PLUGIN_TOKEN` when composition fetches a plugin from it; to use a private plugin on another host, list that host here.

The file is authoritative, not just a dashboard check. Composition reads it from beside the selection file and refuses any entry of `lancerlogin.modules.json` whose source it does not allow, so a direct edit of the selection cannot build a forbidden plugin. Provisioning and web updates (including **Apply plugin changes**) compose this way, and an update with a forbidden source stops in preflight, before maintenance. The matching is the dashboard's: the source's host must equal an entry's host and, for a `host/owner` entry, its owner must match ignoring case. An invalid file refuses composition entirely, even when the selection names no plugin. Core's own pins of the official modules are not checked; a selection entry that pins an official module is.

## Carpool is a plugin

Carpool is no longer part of LancerLogin itself. It is the separately selected Carpool plugin, and an installation includes it only by listing it in `lancerlogin.modules.json`:

```json
{ "id": "carpool", "source": "https://<host>/<owner>/<carpool repository>.git", "commit": "<full commit SHA>" }
```

**An installation that uses Carpool today** adds this entry before, or together with, the update that removes Carpool from Core, and deploys that update through a build that composes its plugins (see the limitation under [Build with plugins](#build-with-plugins)). LancerLogin's list of modules that moved into plugins, `scripts/known-modules.json`, holds the Carpool plugin's repository and released commit. Nothing then changes for its users: the same pages, settings, meeting links, Operator permissions, setup state and data. The plugin adopts the tables that Core migrations already created, so no database change runs. One exception: the plugin no longer reads the `CARPOOL_GEOAPIFY_KEY` deployment variable, because plugins never receive the Worker environment. If location lookup used that variable, save the Geoapify API key in **Settings > Modules > Carpool** (before or after the update), then remove the variable. A key already saved in Carpool settings keeps working.

**An installation that updates without the plugin** keeps all Carpool data in its database:

- If Carpool was enabled, or disabled and awaiting deletion, **Settings > Modules** lists it as no longer installed. Its pages, routes and meeting links stop. It cannot be enabled again without the plugin, only turned off. Seven days after it is turned off, LancerLogin deletes its data using the cleanup steps Carpool had as part of Core. Those steps are recorded even for an installation that never recorded them while Carpool was built in.
- If Carpool was never enabled, nothing is listed and nothing needs to be done.
- Adding the plugin later, while the data is still retained, restores Carpool exactly as it was.
- Backups made without the plugin do not contain Carpool data. Restoring an older backup that holds Carpool data needs the plugin, or an explicit choice to discard that data; see [backup and restore](BACKUP-RESTORE.md).

### Updating an installation that uses a module that moved into a plugin

An update never silently drops a module that the installation still uses. "Uses" means what backups mean by it: the module is enabled, or disabled with data retained or being deleted, or it has its own data, setup progress or Operator assignments. A module that was deliberately disabled and whose data was deleted, or that was never enabled, is not in use.

- **Settings → Updates** checks before an update is prepared, so before any backup is downloaded. It shows, for example, "Carpool is in use and is now a separate plugin." with two actions:
  - **Keep Carpool (add plugin)** opens the plugin change dialog with the plugin repository and released commit from `scripts/known-modules.json`. After review, trust confirmation and fresh authentication, the plugin is committed to `lancerlogin.modules.json` and the update can be prepared. It installs LancerLogin and the plugin together. The plugin adopts the module's existing tables and lifecycle without running any database change, so its data, settings and permissions carry over unchanged.
  - **Remove Carpool** opens Settings → Modules, where the Admin disables it. Its data is retained for seven days as usual, and the update can be prepared once it is no longer in use.
- Without the plugin selection credential, the operator adds the plugin to `lancerlogin.modules.json` in the private repository instead.
- **Updating from v2.0.0-beta.11 or earlier.** These releases have no plugin management and cannot run the first check. Before preparing the update, the operator adds the Carpool entry from `scripts/known-modules.json` to `lancerlogin.modules.json` on `main` in the private deployment repository, creating the file if it is missing, as shown in [Carpool is a plugin](#carpool-is-a-plugin).
- **The installation workflow checks too.** The current `provision-template.yml` runs the same check in its `upgrade` and `resume` paths after composition and before it builds, migrates or deploys, and stops with the module's name and how to keep or remove it. Nothing changes.
- **The update controller checks again before it claims the installation,** against the modules the update actually composes. If a used module would be dropped, the update stops before maintenance and fails with the code `module_migration_required:<module ID>`, and Settings → Updates explains how to keep or remove it. Nothing changes. This covers installations that update from an older release and installations that opted out of official modules. A v2.0.0-beta.11 or earlier dashboard shows only that the update failed; the diagnostic workflow run names the module. Add its entry as above and prepare the update again.

Restoring a backup that holds a module without its plugin is unchanged: restore refuses it, and the Admin installs the plugin first or explicitly discards that module's data.

## Peer dependencies

A plugin declares React, Leaflet and `@lancerlogin/module-sdk` as `peerDependencies`. They are never installed for the plugin: the composed dashboard and Worker use Core's single copy, and composition refuses a peer that Core does not provide or whose installed version is outside the declared range. Other packages go in `dependencies` with a lockfile. Code that composition builds (every file reachable from the plugin's entries) may not import a package declared only in `devDependencies`, since development dependencies are never installed and the import would otherwise resolve to whatever Core has, without the range check.

## Official modules

LancerLogin ships a pinned list of official plugins, `scripts/official-modules.json`, that every installation build composes by default: initial provisioning, web updates (**Settings → Updates**) and `npm run compose:modules` all include them, with or without a selection file. Each LancerLogin release pins the exact commit of each official plugin, so updating LancerLogin also updates them. Outreach is the first official module, published from `https://github.com/isriah/lancerlogin-outreach.git`. Carpool, published from `https://github.com/isriah/lancerlogin-carpool.git`, is not an official module and stays opt-in.

Both plugin repositories are public, so composing them needs no token or workflow change. The optional `LANCERLOGIN_PLUGIN_TOKEN` secret is needed only for a private third-party plugin; see [Build with plugins](#build-with-plugins).

- **Opt out** of all official modules with `"officialModules": false` in `lancerlogin.modules.json`. Their pages, routes, jobs and Discord commands are then absent; see [Outreach is a plugin](#outreach-is-a-plugin) for what happens to existing data.
- **Pin a different commit** of one official plugin by listing it with the same `id`, for example to hold it back for one release. The installation's pin replaces LancerLogin's.
- Official plugins pass the same checks as any plugin, before the update claims the installation or enters maintenance, and post-deployment health must report them. A release whose official list cannot be fetched or checked is refused, never applied without them.

Development builds and tests can leave official modules out with `npm run compose:modules -- --no-official-modules`. A Core build that is never composed contains first-party modules only.

## Outreach is a plugin

Outreach Participation moved out of Core into the official Outreach plugin. It keeps its module ID (`hour-tracking`), routes, public submission page (`/submit-hours`), setup, jobs, Discord commands, report datasets, saved report filters, walkthrough, tables and cleanup steps. Because official modules are composed by default, **an existing installation needs no change**: the update that removes Outreach from Core builds it in as a plugin, the plugin adopts the tables Core migrations already created without running any database change, and its users keep the same pages, settings, permissions, setup state, data, saved reports and publications.

A new installation registers Outreach disabled. Its default settings and the Event, Team Support and Other Service activity types are created when an Administrator first enables it, rather than when the installation is created.

An installation that opts out of official modules keeps all Outreach data in its database, as with any removed plugin:

- If Outreach was enabled, or disabled and awaiting deletion, **Settings > Modules** lists it as no longer installed. Its pages, public form, routes, jobs and Discord commands stop. It can only be turned off; seven days later LancerLogin deletes its data with the cleanup steps it had as part of Core. Until then, roster members with Outreach participation still cannot be deleted.
- If Outreach was never enabled, nothing is listed and nothing needs to be done.
- Saved reports on Outreach datasets remain in the library and report the dataset as unavailable.
- Selecting the official modules again while the data is still retained restores Outreach exactly as it was.
- Backups made without the plugin do not contain Outreach data. Restoring an older backup that holds Outreach data needs the plugin, or an explicit choice to discard that data; see [backup and restore](BACKUP-RESTORE.md#outreach-moved-into-a-plugin).

## Build with plugins

From a Core checkout:

```bash
npm run compose:modules -- --selection path/to/lancerlogin.modules.json
```

Composition fetches each pinned commit, verifies it, installs its locked dependencies without install scripts, and checks the manifest, contract version, Core version range, imports, migrations, backup adapter and conflicts with every other module. It writes the generated module lists only if every plugin passes; then build as usual. Run `npm run compose:modules -- --restore` to return a development checkout to the plugin-free defaults.

Installation and web updates (**Settings → Updates**) compose the official modules and the selection automatically. The update workflow reads `lancerlogin.modules.json` from the private repository when it exists, fetches and checks every official and selected plugin before it claims the update or enters maintenance, and refuses the update if any plugin is incompatible with the target release. After deployment it confirms that every composed plugin is running. Plugin fetching, installation and inspection never receive Cloudflare or update credentials in their environment; as described under [Trust](#trust), that keeps secrets out of plugin code by default but does not isolate it from the workflow that holds them.

**Installation and update workflows from before LancerLogin 2.0.** These workflows keep running in a private deployment repository until the operator replaces them, and their "latest stable" choice selects the newest release. They do not compose plugins. From 2.0, the dashboard and API builds refuse to run in CI (GitHub Actions) unless composition ran for the same LancerLogin version, so such a workflow stops at its build step, before any D1 migration or deployment, with a message naming the workflows to update. A Community controller whose `upgrade-web.yml` runs its own copy of `scripts/run-web-upgrade.mjs` fails the dashboard update the same way, during its build stage, before maintenance. Update `provision-template.yml`, `upgrade-web.yml` and `refresh-web-update-credential.yml` from the current template, then run the upgrade again. A development CI that deliberately builds without plugins sets `LANCERLOGIN_PLUGIN_FREE_BUILD=1`; installation workflows must never set it. Local builds outside CI are not affected.

Private repositories created before plugin support need one change to use private plugin sources: in `.github/workflows/upgrade-web.yml`, give the final step an `env` entry `LANCERLOGIN_PLUGIN_TOKEN: ${{ secrets.LANCERLOGIN_PLUGIN_TOKEN }}`. Public plugin repositories need no workflow change.

## Plugin releases and tracks

The Outreach and Carpool plugin repositories follow the same release rules as LancerLogin itself: canonical tags `vX.Y.Z` (stable) and `vX.Y.Z-beta.N` (beta), patch notes in `docs/releases/<tag>.md`, a successful verification run for the exact tagged commit before a release is published, and immutable published releases. The highest version wins, never the most recent publication: `1.1.0-beta.10` follows `1.1.0-beta.9`, and `1.1.0` follows every `1.1.0-beta.N`. Each plugin's README states the LancerLogin versions it supports (its `lancerlogin.core` range); composition refuses a plugin outside that range.

Plugin repositories also publish **nightly** prereleases, `vX.Y.Z-nightly.YYYYMMDD`, from their `main` branch when it has new commits that passed verification. A nightly sorts below every beta of the same `X.Y.Z`, is never offered to the Stable or Beta tracks, and is for test installations only. Do not pin a nightly on an installation that people depend on.

Pins stay exact commits. To move a selection to the newest release on a track, run from a Core checkout with an existing GitHub CLI login that can read the plugin repositories:

```bash
npm run plugins:resolve -- --selection path/to/lancerlogin.modules.json --track stable
npm run plugins:resolve -- --selection path/to/lancerlogin.modules.json --track beta --module carpool
```

`--track` is `stable` (stable releases), `beta` (beta and stable) or `nightly` (nightly, beta and stable). Without `--track`, each entry uses its own `track` (stable when absent). The helper accepts only published, immutable releases from `https://github.com/<owner>/<repository>.git` sources, resolves the chosen tag to its full commit SHA and writes that SHA into the selection. Tags are never stored. `--module <id>` limits the change to one entry and `--dry-run` prints the result without writing. Review the change between the old and new commits, then deploy as usual. Core maintainers use the same command on `scripts/official-modules.json` when a LancerLogin release adopts a new official plugin release.

## After deployment

Before a new deployment serves its first request, and again on every five-minute maintenance pass, LancerLogin applies each plugin's pending database migrations and registers new plugins as disabled. If that cannot run, for example while the database is unavailable, the Worker retries within a minute. Enable a plugin there, then complete its setup. A plugin whose database setup fails appears as setup incomplete and retries automatically; other modules keep working.

Update a plugin by changing its pinned commit, in Settings → Modules or in `lancerlogin.modules.json`, and deploying it with **Apply plugin changes** or the next update. New migrations apply before the new build serves its first request. A plugin can never move to an older commit whose migrations are behind what the installation already applied.

## Remove a plugin

Disable the plugin in **Settings → Modules** first. Its data is retained for seven days and then deleted. You can remove it from `lancerlogin.modules.json` at any time after disabling. Settings → Modules removes it only once that data is deleted, then **Apply plugin changes** deploys the removal.

If a plugin's code is removed while it is still enabled, Settings lists it as no longer installed. Its routes, pages and jobs stop. You can only turn it off; LancerLogin still deletes its retained data seven days later, using the cleanup steps recorded while it was installed.

## Backups and restore

Entire-installation backups include each plugin's portable data in a separate section, with its source and commit. Restoring a backup that contains a plugin this installation does not have, or a newer version of one, is refused before any change. The refusal names each plugin, the version it needs and where its code lives. Install the plugin and retry, or explicitly confirm a restore that discards those plugins' data. See [backup and restore](BACKUP-RESTORE.md).
