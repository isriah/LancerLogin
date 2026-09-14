# Web updates

This guide is for Administrators preparing a dashboard installation update and maintainers responsible for its fixed private controller. A web update changes the Cloudflare dashboard installation. It is separate from a physical kiosk update, which is described in [KIOSK.md](KIOSK.md).

## Update the dashboard installation

1. Sign in as an Administrator and open **Settings → Updates**.
2. In the **Dashboard** card, choose **Back up and begin update**. Review the pinned release notes.
3. Choose **Download entire-installation backup**, save the file securely outside the installation, and select the confirmation checkbox. Refreshing the page never confirms that you saved the file.
4. Choose **Start update to vMAJOR.MINOR.PATCH** once it becomes available. Track any required GitHub approval and the deployment status in the card.
5. Choose **Reload updated dashboard** only after the card reports verified completion. If the card reports recovery required or progress cannot be confirmed, stop and use the diagnostic link with an authorized recovery plan. Do not start another update or restore D1 automatically.

The fixed private `upgrade-web.yml` workflow runs on `main`. Only an active Admin can prepare, start, or read status. Mutations require the exact dashboard Origin and JSON. The browser cannot select a repository, workflow, ref, slug, or executable parameter. One complete stable official release is resolved and pinned by public commit. Downgrades are refused.

## Fixed database identity

An installation rename may keep its original D1 name. Set optional `LANCERLOGIN_DATABASE_NAME` in the private repository or production environment; workflows pass it to controller scripts as `DATABASE_NAME`. If unset, it defaults to `<installation-slug>-data`. Never add database identity as a workflow-dispatch input.

Keep the fixed name with the existing database UUID in configuration generation, backups, migration commands, credential maintenance and recovery. Preflight still verifies provider metadata and the Worker DB binding against the selected account. Backup and restore commands use the actual database name, not a newly derived name. Rename is a separate reviewed cutover and reversal procedure; do not run fresh provisioning or a same-version upgrade to perform it.

## Dashboard API

These Worker routes are called under the dashboard's same-origin `/api` prefix. Responses are JSON with `cache-control: no-store`.

| Method and route | Input | Result |
| --- | --- | --- |
| GET `/admin/releases/latest` | None | Complete official stable release metadata, last successful `checkedAt`, last provider `attemptedAt`, `fresh`, and optional failure diagnostics / `retryAt`. Admin-only discovery does not prepare or dispatch. |
| POST `/admin/web-updates/prepare` | `{}` | Active request or new latest-stable pinned request; thirty-minute expiry. Repeated prepare reuses it. |
| GET `/admin/data/backup?scope=installation&updateRequestId=<requestId>` | None | Schema-13 entire-installation JSON attachment; records backup export against the prepared request. |
| POST `/admin/web-updates/start` | `{ "requestId": "<prepared UUID>", "backupSaved": true }` | HTTP 202 with durable request. Requires associated export and explicit saved-file confirmation. Replay never redispatches. |
| GET `/admin/web-updates/status` | None | Most recent durable request; provider polling admitted once per ten seconds across tabs/Workers. |

Prepare/start/status return `{ releaseVersion, workflowUrl, request }`. `request` is null without history; otherwise: `requestId`, `targetTag`, `targetCommit`, plain-text `releaseNotes`, fixed official `releaseUrl`, `previousVersion`, `state`, `stage`, `createdAt`, `expiresAt`, `updatedAt`, `backupExported`, `maintenance`, nullable `errorCode`, nullable `runUrl`, and `reloadReady`. Render notes as text or sanitized Markdown, never trusted HTML. Reload only when `reloadReady === true`. HTTP 202, successful dispatch and successful GitHub run are insufficient.

States: `prepared`, `dispatching`, `queued`, `awaiting_approval`, `running`, `verifying`, `succeeded`, `failed`, `recovery_required`, `expired`. Stages identify build/checkpoint/migrations/API deployment/Pages deployment/health. Keep the fixed workflow/run URL as diagnostics/manual recovery; environment approval stays in GitHub. Reloads resume through status without browser-local request storage. Failed/expired requests permit deliberate new prepare; recovery-required retains the active lock. Started requests impose a two-minute cooldown.

Settings keeps **Dashboard** and **Physical kiosk** updates separate. Preparing shows pinned release notes as plain text; download the associated entire-installation backup, save it securely, then check the saved-file confirmation to enable **Start update to vMAJOR.MINOR.PATCH**. Refreshing or opening another tab restores server progress but never restores that confirmation. GitHub approval is shown as a direct review link when required; request IDs, technical stages, and manual recovery links are under **Diagnostics and manual recovery**. The explicit **Reload updated dashboard** action appears only after verified finalization and when the running JavaScript bundle differs from the target version; persisted success never causes automatic reload loops.

Errors use `{ error, code }` plus existing authorization errors. Safe codes: `not_configured`, `credential_required`, `credential_expired`, `not_private`, `workflow_required`, `cooldown`, `already_current`, `release_unavailable`, `invalid_request`, `request_missing`, `request_expired`, `backup_required`, `provider_unavailable`, `run_mismatch`. Definite dispatch credential/cooldown rejection is retained as `request.errorCode`; uncertain outcomes use `dispatch_ambiguous`. Both retain the one-way claim and return 202/current request. Inspect state/error instead of treating 202 as success. Reconcile the exact request run-name and workflow path; multiple/unresolved runs become `dispatch_unresolved` recovery after fifteen minutes. Never blind redispatch. Completed failure before executor claim is `failed/preflight_failed`; a completed claimed executor without verified finalization requires recovery.

The partial unique installation index and permanent executor claim prevent concurrent dispatch, duplicate-run mutation and same-run rerun mutation. Database audit triggers record the server-authenticated Admin once on prepare/start. Polling cannot overwrite terminal workflow finalization. Reads and sign-in/logout remain available during maintenance; domain mutations, kiosk attendance and scheduled provider writes pause. Kiosks receive retryable HTTP 503/Retry-After and retain disk queues through restart/replay.

Release discovery uses the same-origin API, not direct browser access to GitHub. The Worker caches successful checks for at most fifteen minutes and coalesces concurrent discovery requests within its isolate. Manual checks still respect this bounded cache and provider cooldowns. Failed responses keep previous metadata unconfirmed, distinguish rate limits, timeouts, network failures, invalid releases and other provider errors, and report a retry time. Provider `Retry-After` (seconds or date) and exhausted rate-limit reset times are respected. Isolate restarts and multiple Workers may perform independent checks; this is not a global GitHub quota lock.

The dashboard persists useful discovery status in a separate same-origin cache namespace, so an old direct-browser failure cannot block the new route. It displays successful and failed check times separately. Previously checked metadata never authorizes preparation, and browser metadata is only a display hint: preparation independently resolves the complete official release and pins its public commit before the associated backup and single-dispatch flow.

An already installed dashboard uses the updater shipped with that version. Publishing a discovery fix does not change that running bundle. If its direct-browser lookup is blocked, installing the fixed version first requires a separately authorized exact-release deployment through the private controller. Do not bypass backup, pinned-release, resource-identity, or dispatch checks.

## Maintainer controls

Definite dispatch credential/cooldown rejection ends this request as failed with its diagnostic code, allowing deliberate new prepare after renewal/cooldown. Its existing request ID still cannot redispatch. Uncertain provider/network outcomes retain the active claim for reconciliation.

The reviewed `upgrade-web.yml`, `refresh-web-update-credential.yml`, and controller scripts live in the existing private deployment repository. Install or change them only through a separately approved repository change. App upgrades never rewrite the private controller. Provision, upgrade, and refresh share `lancerlogin-production-installation` concurrency and `production`; enable required reviewers where supported.

Through GitHub's secure token UI, create a fine-grained token scoped to **only the private deployment repository**, with **Actions: write** and default Metadata read. Default expiry is ninety days where policy permits. Save its value as production environment secret `LANCERLOGIN_WEB_UPDATE_TOKEN`. Cloudflare account-owned scoped credentials remain in environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Never put values in chat, command arguments, D1, backups, tracked files or logs.

Record production environment variables from confirmed existing resources: `LANCERLOGIN_INSTALLATION_SLUG`, exact `LANCERLOGIN_DATABASE_ID` UUID, exact `LANCERLOGIN_API_URL` HTTPS Worker origin, and ISO UTC `WEB_UPDATE_TOKEN_EXPIRES_AT` matching token expiry. Provisioning verifies private token access before cloud mutation and uploads `WEB_UPDATE_TOKEN` plus `WEB_UPDATE_TOKEN_EXPIRES_AT` as Worker secrets after the Worker exists. Renewal updates the GitHub secret/expiry through provider UI and runs **Refresh web update credential** with current live authorization. It verifies exact account-token/D1/Worker binding before uploading only those two secrets. It cannot recreate resources or rotate `SESSION_KEY`, `INTEGRATION_KEY`, `BOOTSTRAP_CODE_HASH`.

Actions-read preflight proves access/workflow existence, not Actions-write permission without dispatch. Configure the permission and record live acceptance. The update token never enters workflow inputs, D1, backups or API output. The trusted private controller runs only on `main`, checks out official source by exact recorded SHA, and verifies release/tag/package identity again.

## Executor and compatibility review

Exact resources/secrets are checked before the durable executor claim. API/dashboard builds precede maintenance and migration/deployment. After maintenance and sixty-second drain, record a D1 Time Travel bookmark, previous API version, Worker deployment/version IDs and Pages production deployment ID in operational `recovery_json`. Checkpoint failure precedes migration. Apply compatible forward-only migrations, deploy API then Pages, and verify API ready/release, Pages' independent `/__lancerlogin-release`, same-origin proxy health, canonical Pages commit, retained D1 binding and secret names before success. No automatic code rollback or D1 restore occurs.

`scripts/web-upgrade-policy.json` is release-owned compatibility metadata: all migrations' LF-normalized SHA-256, explicit forward compatibility, minimum installed version and disabled automatic code rollback. Applied migrations must be an exact prefix. Unknown/ahead schema, changed/unreviewed hashes, unsupported installed version or downgrade fails before claim. Future migration authors/release reviewers must assess old running-code and queued-scan compatibility, update only reviewed entries, and run API/provisioning/migration/rehearsal checks. Never regenerate hashes to bypass failed compatibility. Generation/validation normalize LF identically on Windows/Linux. Any operator code rollback requires review against the resulting schema.

## Recovery and rehearsal

`npm run rehearse:web-upgrade` is an eleven-case **synthetic-only** bridge/V1 and failure rehearsal. It proves no live dispatch, approvals, token write permission, Cloudflare resource preservation, Time Travel retention, fresh-adopter setup or Pi acceptance. Separately authorized isolated synthetic-data provider rehearsal and live acceptance remain required. Never put real attendance, credentials or pairing into fixtures/evidence.

On recovery-required, retain write suspension and inspect the private run and operational recovery record securely. Record exact API/Pages releases, IDs, migrations and bookmark; protect a fresh sensitive D1 backup outside source/logs. An unresolved dispatch without a proved run cannot automatically unlock. Cancellation/process death may retain maintenance deliberately. Repair deployments only with live authorization and review schema compatibility before rollback. Database restore requires distinct explicit recovery authorization plus retained encryption/session/pairing context; never automate it.

After a known completed run and both releases healthy on the **same** previous or target version, use `scripts/recover-web-update.mjs` only with current live recovery authorization. Provide fixed resource process environment metadata and provider credentials securely, `RECOVERY_REQUEST_ID`, exact `RECOVERY_CONFIRMATION=RECOVER WEB UPDATE <UUID>`, and `RECOVERY_SCHEMA_COMPATIBILITY_REVIEWED=yes` after review. It verifies account/resources, exact completed workflow request and both releases/health before clearing maintenance. It does no restore/rollback/resource creation/credential rotation. An unproved run requires manual provider investigation; never fabricate a run ID.

Operational rows are excluded from dashboard category backups/restores and have no installation cascade. Application restore or deletion cannot erase an active lock. Full provider D1 exports and Time Travel retain the table; inspect restored control state before resuming service.

## Current release and migration evidence

The stable public release is v1.0.4. Each installation must verify its own data, session, migrations, update tracking, and maintenance state. Web-update evidence does not establish physical-kiosk operation, and physical-kiosk evidence does not establish web-update completion.

The private deployment repository has an inherited CI assertion failure. Do not describe all private CI as green. The isolated rehearsal has a historical reload-card limitation after manual version changes. These facts and the earlier waived physical checks are evidence limits, not reasons to bypass the fixed web-update controls.

## References and limits

Verified [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event): version `2026-03-10` returns HTTP 200 with `workflow_run_id`, requires fine-grained Actions write. Reconciliation uses [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs). [D1 command docs](https://developers.cloudflare.com/d1/wrangler-commands/) document Time Travel JSON; installed Wrangler 4.127.1 confirms `result.bookmark` and Workers `{ deployments: [...] }` with version IDs. [Pages deployments API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/) documents source commit metadata. Tests use real SQLite SQL constraints and synthetic/mocked provider IO; these do not validate live adapters. Windows cannot establish Linux/systemd/Pi behavior.
