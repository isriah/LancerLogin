# Stable and Beta update tracks

This page describes how update tracks behave. To choose a track, see [Choose an update track](https://isriah.github.io/LancerLogin/updates.html#tracks) on the documentation site.

## Track rules

An Admin chooses the track in **Settings > Updates > Update track**. Stable is the default and a newly provisioned installation starts on it. Choosing Beta requires acknowledging the warning and choosing **Save update track**. The server stores the installation-wide choice with a revision and records it in the audit log.

Saving a track never installs software. Dashboard updates still require a prepared release, an entire-installation backup and an explicit start. Each physical kiosk needs its own **Update kiosk** command, and kiosk updates follow the same track.

Stable offers complete official stable releases. Beta offers complete official beta and stable releases, selecting the highest version rather than the most recently published. For example, `2.0.0-beta.10` follows `2.0.0-beta.9`, and stable `2.0.0` follows every `2.0.0-beta.N`.

Returning to Stable does not remove modules or downgrade installed software. If the latest stable version is older than the installed beta, the installation waits for a newer stable release. Restoring older code or a database is a separate recovery decision, not a track switch.

Changing tracks expires unstarted prepared web updates. Tracks cannot change during a started web update or a recent pending kiosk update. Track consent is operational state, excluded from application backups and restores like deployment locks; a full D1 export retains it.

## Module plugin tracks

Module plugins, such as the official Outreach plugin and the optional Carpool plugin, publish their own stable and beta releases under the same version rules, plus testing-only nightly prereleases (`X.Y.Z-nightly.YYYYMMDD`). A nightly is lower than any beta of the same version and is never offered to Stable or Beta. The installation's track does not change plugin pins; see [module plugins](MODULE-PLUGINS.md#plugin-releases-and-tracks).

## Upgrading from LancerLogin 1

A LancerLogin 1 (Community) installation reaches LancerLogin 2 in place through the v1.2.6 bridge, which installs the track-aware updater on the dashboard and the track-aware update helper on each kiosk. Follow [Upgrade Community to Modular](COMMUNITY-UPGRADE.md). In short:

1. Install the v1.2.6 bridge on the dashboard with the stable web updater, then on each kiosk while Stable is selected.
2. Update the private repository's `.github/workflows/upgrade-web.yml` from the bridge release. Its name must be **Upgrade LancerLogin web (update channels v2)** and its Node runtime 24.10 or later. Keep the confirmed resources, the `production` environment and its reviewers. Application updates never rewrite this workflow themselves.
3. Opt in to the track that offers the LancerLogin 2 release, prepare the update with a new backup, and update each kiosk afterwards.

A kiosk without the track-aware helper is blocked from Beta until it installs the bridge. The bridge checks the private workflow's capability before preparing a Beta update, and the executor rechecks release flags, complete assets, immutable beta metadata, exact tag and commit, the request's track and current consent.

`0061_update_channels.sql` is the one reviewed migration that may sit outside the ordinary migration prefix, because LancerLogin 1 installs it before the LancerLogin 2 module migrations. Do not renumber historical migrations or regenerate hashes to bypass a failed upgrade.

## Release publication

Track discovery accepts only complete official releases with canonical tags and matching prerelease flags. Beta releases are GitHub prereleases and never GitHub Latest; stable publication advances Latest only to a higher stable version. Physical kiosks require an immutable release on every track and verify the installer and archives against GitHub's recorded asset digests. The maintainer publication procedure is in [development](DEVELOPMENT.md#release-preparation).
