# Installation reference

Step-by-step instructions are on the documentation site: [Install](https://isriah.github.io/LancerLogin/setup.html) and [First sign-in and setup](https://isriah.github.io/LancerLogin/first-run.html). This page records how the installation workflow and first-Admin setup behave.

## Installation workflow

**Install or upgrade LancerLogin** (`.github/workflows/provision-template.yml`) runs in the private deployment repository's `production` environment. It refuses to run in a public repository.

| Input | Values |
| --- | --- |
| `operation` | `create` for a new installation, `resume` to continue an interrupted one with the same slug, `upgrade` to update an existing one. |
| `release` | `latest stable`, the newest official stable release, or `latest beta`, the newest complete official release on the Beta track (a beta, or a stable release when that is newer). `latest beta` is accepted only with `upgrade`, and only for an installation already on the Beta track. |
| `installation_slug` | Matches `^[a-z][a-z0-9-]{2,40}$`. |

Required environment secrets are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `LANCERLOGIN_SETUP_CODE` (at least 16 characters). `LANCERLOGIN_WEB_UPDATE_TOKEN` and `LANCERLOGIN_MODULE_SELECTION_TOKEN` are optional; see [web updates](WEB-UPDATES.md) and [module plugins](MODULE-PLUGINS.md#module-selection-credential). When one is set but expired, revoked or otherwise unusable, `create` stops before any change and names it, while `resume` and `upgrade` warn and continue without it; see [Update without the token](WEB-UPDATES.md#update-without-the-token). That rule and the `latest beta` choice come with the workflow file from v2.1.0-beta.10: a deployment repository keeps the copy it was created with, and an older copy stops every operation at an expired token until the secret is deleted or the file is [replaced](WEB-UPDATES.md#repository-workflow-files).

Before creating anything, a read-only preflight verifies the account token against the account ID, checks each required token permission, checks that the account has a `workers.dev` subdomain, and checks that the Pages project would get the exact address `<slug>-dashboard.pages.dev` (`pages_address_taken` otherwise). Resources are created only after the API and dashboard builds succeed, and `resume` finishes an interrupted `create`. For an existing installation the workflow reads the installed release from the Worker's public `/health` (or, when it does not answer, from the Worker's settings in Cloudflare) and never deploys an older one (`release_downgrade_refused`); the same release is deployed again. See [web updates](WEB-UPDATES.md#update-without-the-token). Its last step polls the Worker's `/health` and the dashboard's `/api/health` for up to two minutes until both report the release just installed in the mode `ready` (`installation_health_*` otherwise); a new installation already reports `ready` before its first Admin exists. Each failure is reported as an `::error title=<code>::` annotation; the codes and fixes are listed in [Troubleshoot the installation workflow](https://isriah.github.io/LancerLogin/troubleshooting.html#install). It creates `<slug>-api` (Worker), `<slug>-data` (D1) and `<slug>-dashboard` (Pages). Pages project names are global across Cloudflare, so a taken name stops the run and asks for another slug. The run summary lists the dashboard URL and the values for the `LANCERLOGIN_INSTALLATION_SLUG`, `LANCERLOGIN_DATABASE_ID` and `LANCERLOGIN_API_URL` environment variables that one-click dashboard updates (`upgrade-web.yml` and `refresh-web-update-credential.yml`) read; this workflow's own `upgrade` operation does not need them. For the Cloudflare token itself, see [Cloudflare linking](CLOUDFLARE-LINKING.md).

## First-Admin setup

The dashboard's **Create your installation** form needs the setup code. The Worker stores only a hash of it as the `BOOTSTRAP_CODE_HASH` secret. The form creates the installation record and the first Admin together and signs that Admin in. After that, the bootstrap route is closed.

While no Admin exists, the setup code can be changed: update `LANCERLOGIN_SETUP_CODE` and run the workflow with `resume` and the same slug. After **Delete installation** in Settings, only the browser that deleted it can run first-Admin setup again with the same code, within one hour. Anyone else, or that browser later, needs a new setup code applied the same way.

If every Admin later loses their password, use [local recovery](LOCAL-RECOVERY.md) rather than reopening first-Admin setup.
