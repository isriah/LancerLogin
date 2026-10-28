# Stable and Beta update tracks

This guide is for installation Administrators and maintainers of adopter-owned private deployment repositories.

## Choose a track

Open **Settings → Updates → Update track** as an Admin. Stable is the default. Choose Beta, acknowledge the warning and choose **Save update track** to opt in. The server stores the installation-wide choice and records it in the audit log.

Saving a track never installs software. Dashboard updates still require a prepared release, an entire-installation backup saved outside the installation, and an explicit **Start update**. Each physical kiosk needs its own explicit update command.

Stable offers complete official stable releases. Beta offers complete official beta and stable releases, selecting the highest version rather than the most recently published date. For example, `2.0.0-beta.10` follows `2.0.0-beta.9`, and stable `2.0.0` follows every `2.0.0-beta.N`.

Returning to Stable does not remove modules or downgrade installed software. If the latest stable version is older than your installed beta, wait for a newer stable release. Restoring older code or a database is a separate reviewed recovery procedure, not a track switch.

Changing tracks expires unstarted prepared web updates. Download a new associated backup when you prepare again. Tracks cannot change during a started web update or a recent pending kiosk update. Other tabs recheck the server; their saved release metadata cannot authorize an update.

Track consent is operational state, deliberately excluded from application backups/restores just like active deployment locks. A full provider database export retains it. A newly provisioned installation defaults to Stable.

## Module plugin tracks

Module plugins, such as the official Outreach plugin and the opt-in Carpool plugin, publish their own stable and beta releases under the same version rules, plus testing-only nightly prereleases (`X.Y.Z-nightly.YYYYMMDD`). A nightly is lower than any beta of the same version and is never offered to Stable or Beta. The installation's track setting above does not change plugin pins; a maintainer chooses plugin releases in the private deployment repository with `npm run plugins:resolve`. Use nightly plugin builds only on test installations. See [module plugins](MODULE-PLUGINS.md#plugin-releases-and-tracks).

## Upgrade an existing Community installation

1. Preserve an entire-installation backup and the existing provider secrets, database identity and private deployment configuration.
2. Use the existing backup-first stable web updater to install the **v1.2.6 Community bridge**. Reload only after verified Worker/Pages completion. A broken older updater needs a separately authorized maintainer-assisted exact-release upgrade, not a bypass of resource or recovery checks.
3. Review and update the private controller as described below. Application updates never silently rewrite that private workflow.
4. While Stable is selected, explicitly update each physical kiosk to the bridge. Confirm its installed version and online status. The bridge installs the channel-aware root helper while retaining pairing, local configuration, sensor templates and the offline queue.
5. Opt in to Beta and prepare the offered Modular release. Review its notes, download and preserve a new entire-installation backup, then start the web update. Update each physical kiosk separately afterwards.

An older kiosk is blocked from Beta until it advertises the installed channel-aware helper. If you opted in too early, finish active updates, temporarily return to Stable and install the kiosk bridge first. Do not re-enroll fingerprints merely to install the bridge. Follow the Modular release's own enrollment and migration instructions when moving to Modular.

Fresh installations start on the stable template path. Opt in only after the stable installation, private controller and physical kiosk prerequisites are ready.

## Maintainer: private controller

Make a reviewed change in the existing adopter-owned private deployment repository before permitting beta updates. Copy the reviewed `.github/workflows/upgrade-web.yml` from the bridge, preserving confirmed fixed resources, the production environment and required reviewers. Its name must be **Upgrade LancerLogin web (update channels v2)** and its Node runtime must be 24.10 or later.

The workflow checks out pinned official source before executing the release-owned controller. A customized bootstrap that copies individual scripts must also include their reviewed dependencies: the controller and Pages proxy now use `packages/shared/src/release-policy.mjs`. Do not simply rename an old workflow to advertise support.

Keep the scoped Actions-write credential, fixed private routing, exact Worker/Pages/D1 identities and concurrency guard. No arbitrary repository, URL, shell command or extra dispatch input is needed. Updating the controller and provider configuration are separate authorized operations.

The bridge checks the private workflow's capability before preparing Beta. The executor independently rechecks canonical release flags, complete assets, immutable beta metadata, exact tag/commit, the durable request's track and current consent. An unconfirmed result never permits automatic redispatch, rollback or database restore.

`0061_update_channels.sql` is explicitly independent of Modular's module-platform migration and migrations `0040` through `0060`. Only that reviewed bridge may sit outside the ordinary migration prefix. Ordinary migrations must remain in order with unchanged reviewed hashes. Do not renumber historical migrations or regenerate hashes to bypass a failed upgrade.

## Maintainer: release publication

Stable source is reviewed on public `main`; beta source on public `modular`. Use canonical tags such as `v1.2.6` and `v2.0.0-beta.1`. Package version, notes file and tag must agree.

The exact source commit must pass complete **Verify** coverage on its trusted branch before tagging. **Build LancerLogin release** validates both kiosk archives on Linux as an unprivileged service account and preserves one source-bound bundle. CI has read-only repository access and publishes nothing.

From the reviewed publication-tools checkout, a maintainer with an existing GitHub CLI login runs `node scripts/release-publication.mjs publish TAG RUN_ID` to verify the bundle without writing a release. Add `--publish` for the explicit final step. The command independently checks the tag and complete trusted-branch CI, verifies the downloaded bundle digest and all six assets, checks that immutable releases are enabled, assembles or resumes a draft, then publishes and verifies its flags, hashes and immutable status. GitHub requires repository Administration-read access for the immutability check and Contents-write access for publication; no additional token is stored in Actions.

For an existing verified tag whose packaging run failed, run **Build LancerLogin release** manually from `main` with that exact `release_tag`. This rebuilds its accepted source without moving the tag. Use the resulting run ID for the maintainer command. Published releases are never replaced. An uncertain publication result requires checking the release before any retry; the command refuses to overwrite a published release.

Beta releases are GitHub prereleases and never GitHub Latest. Stable publication advances Latest only to a higher stable version. Track discovery accepts only complete official releases with matching canonical tags and prerelease flags; beta releases must also be immutable. Physical kiosks require an immutable release on every track, stable included, and verify the installer and archives against GitHub's recorded asset digests, so publish kiosk releases only through the immutable-release command above.

Publication does not deploy an installation or update a Pi. Keep live acceptance separately authorized. See [web updates](WEB-UPDATES.md) and [kiosk operations](KIOSK.md).
