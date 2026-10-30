# Installation reference

Step-by-step instructions are on the documentation site: [Install](https://isriah.github.io/LancerLogin/setup.html) and [First sign-in and setup](https://isriah.github.io/LancerLogin/first-run.html). This page records how the installation workflow and first-Admin setup behave.

## Installation workflow

**Install or upgrade LancerLogin** (`.github/workflows/provision-template.yml`) runs in the private deployment repository's `production` environment. It refuses to run in a public repository.

| Input | Values |
| --- | --- |
| `operation` | `create` for a new installation, `resume` to continue an interrupted one with the same slug, `upgrade` to update an existing one. |
| `release` | `latest stable`, the newest complete official stable release. |
| `installation_slug` | Matches `^[a-z][a-z0-9-]{2,40}$`. |

Required environment secrets are `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `LANCERLOGIN_SETUP_CODE` (at least 16 characters). `LANCERLOGIN_WEB_UPDATE_TOKEN` and `LANCERLOGIN_MODULE_SELECTION_TOKEN` are optional; see [web updates](WEB-UPDATES.md) and [module plugins](MODULE-PLUGINS.md#module-selection-credential).

Before creating anything, a read-only preflight verifies the account token against the account ID, checks each required token permission, checks that the account has a `workers.dev` subdomain, and checks that the Pages project would get the exact address `<slug>-dashboard.pages.dev` (`pages_address_taken` otherwise). Resources are created only after the API and dashboard builds succeed, and `resume` finishes an interrupted `create`. Each failure is reported as an `::error title=<code>::` annotation; the codes and fixes are listed in [Troubleshoot the installation workflow](https://isriah.github.io/LancerLogin/troubleshooting.html#install). It creates `<slug>-api` (Worker), `<slug>-data` (D1) and `<slug>-dashboard` (Pages). Pages project names are global across Cloudflare, so a taken name stops the run and asks for another slug. The run summary lists the dashboard URL and the values for the `LANCERLOGIN_INSTALLATION_SLUG`, `LANCERLOGIN_DATABASE_ID` and `LANCERLOGIN_API_URL` environment variables used by later updates. For the Cloudflare token itself, see [Cloudflare linking](CLOUDFLARE-LINKING.md).

## First-Admin setup

The dashboard's **Create your installation** form needs the setup code. The Worker stores only a hash of it as the `BOOTSTRAP_CODE_HASH` secret. The form creates the installation record and the first Admin together and signs that Admin in. After that, the bootstrap route is closed.

While no Admin exists, the setup code can be changed: update `LANCERLOGIN_SETUP_CODE` and run the workflow with `resume` and the same slug. After **Delete installation** in Settings, only the browser that deleted it can run first-Admin setup again with the same code, within one hour. Anyone else, or that browser later, needs a new setup code applied the same way.

If every Admin later loses their password, use [local recovery](LOCAL-RECOVERY.md) rather than reopening first-Admin setup.
