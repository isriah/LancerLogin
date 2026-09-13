# Authenticated in-app updater controls

WU-172 replaces the cloud application's GitHub workflow handoff with authenticated
independent-updater controls. Dependencies: WU-168 signed bundles, WU-169 engine,
WU-170 release source, WU-171 provider/staging adapters and independently approved
bootstrap. This milestone provides the actual HTTP service factory and dashboard
flow; it does not provision a Worker, deploy the factory, publish a signed release
or claim hosted upgrade acceptance. Physical kiosk source selection and its
`install_latest` command remain unchanged.

## Composition and authentication

`createUpdaterService({ engine, source, store, database, capability, installationId,
appSecret })` in `apps/updater/service.mjs` accepts the actual server-owned engine,
source and independent updater D1. It returns `fetch(request)` and trusted
`checkAvailability()` for later scheduler composition. Bootstrap supplies the
same opaque capability to this service and engine; it never leaves the updater.
Apply `state/0003_updater_service.sql` only to updater-state D1, after its existing
state/storage migrations. It is not part of application schema or portable backup.

The application optionally receives private `UPDATER` service binding,
`UPDATER_INSTALLATION_ID` and `UPDATER_APP_KEY`. The last is a separately provisioned
32-byte shared request-authentication key represented as 64 lowercase hex digits.
It is not a deployment credential or a release-signing private key. The updater
factory receives the matching `appSecret`; deployment/provider/signing credentials
remain absent from the browser and application's service-auth helper.

Every `/admin/updater/*` API request first reloads the active stored user's role
through the existing `requireRole(..., ['admin'])`. A signed session claiming Admin
does not override a current Staff/Operator role. The API validates a fixed action
schema and signs the exact body digest, HTTP method/path, installation, fixed
`lancerlogin-updater-v1` audience, timestamp, nonce and actor ID with HMAC-SHA-256.
The portable helper lives at `packages/shared/src/updater/service-auth.ts`.

The updater accepts at most 4 KiB request bodies, a 60-second timestamp window,
and a valid MAC. Only then does it atomically claim the nonce in updater D1;
replay returns 409 without calling the engine. Nonces are retained beyond their
valid timestamp window and expired entries are pruned. Caller-supplied role,
repository, URL, SQL, key, binding or capability fields are rejected. The API
service response has a 16 KiB read bound and a 35-second deadline. Errors expose
fixed messages, not upstream bodies, signed manifests or checkpoint ciphertext.

## Fixed routes and public status

API routes use `/admin/updater/`; the private service uses `/v1/` with the same
action name. Only `status` is GET; all other actions are POST JSON.

| Action | Exact body |
| --- | --- |
| `status` | Empty |
| `check` | `{}` |
| `start` | `{ requestId, releaseId }` |
| `advance` | `{ jobId }` |
| `retry-preparation` | `{ jobId, failedOperationId }` |
| `recovery` | `{ requestId, failedJobId, mode, confirmation }` |

Request/job/operation IDs are bounded UUIDs; release IDs are positive safe integers.
Recovery mode is `code-recovery` with confirmation `RECOVER APPLICATION CODE`, or
`restore` with the exact typed phrase `RESTORE APPLICATION DATABASE`. Restoration
also remains subject to the engine's verified-backup and write-quiescence gates;
a UI confirmation cannot enable an unimplemented or unsafe adapter.

Status returns `configured`, `installedVersion`, `schema`, `highestSequence`,
bounded engine `job`, `recoveryAvailable`, `availability` and `admission`. The job
adds its opaque `requestId` for admission reconciliation. Availability exposes
only status, checked/total counts, checked timestamp and verified available
version/release ID. Source identities, manifests and discovery cursors stay in
updater D1. A stored availability result is bound to the full installed snapshot;
admission, migration or completion changes invalidate its display and progress,
so the just-installed release is not still advertised.

`check` advances the source's incremental discovery by one bounded invocation.
The result and cursor are saved with revision compare-and-swap. Concurrent checks
may repeat harmless provider reads; only one saves the next revision. Check errors
are displayed as failed and require a fresh check rather than false availability.
No availability check performs a deployment. Dashboard polling automatically
continues an unfinished check; the factory also exposes a trusted scheduler entry
point for future automatic checks when no browser is open.

## Admission, progress and recovery

The service accepts only the selected stored verified release. It resumes that
exact immutable source identity before engine admission. A durable admission row
claims the UUID first and records `pending`, `accepted` or `rejected`. The original
owner records a definite pre-admission rejection; matching engine-job readback
records acceptance. A repeated pending request only reads its existing state and
cannot create another job. An unclassified failure stays pending: timeout does
not prove rejection. Independent administrative reconciliation is still needed
if an admission crashes after its durable claim but before a job can be proved.

The browser saves the request UUID and selected release before dispatch. After a
lost response, refresh or retry uses that same admission. It clears the saved
selection only after a matching accepted/rejected record or matching job is seen,
including a terminal job. Confirmed rejection allows a fresh selection; unknown
admission never silently becomes a new request. Recovery similarly saves its UUID,
failed job and mode across reload, while a known recovery job becomes the active
progress surface. No credentials or document contents enter these local caches.

Each explicit Continue/Reconcile action calls one bounded engine advance. The
updater retains actual operation identities and applies the WU-169/171 pending,
unknown, reconciliation and preparation-retry contracts. Polling refreshes status;
it does not automatically dispatch migration/deployment/recovery operations.
The dashboard hides its update popup while already on Updates, keeping controls
reachable. An absent binding shows the installed application version and an
explicit unconfigured state, with no install action or GitHub workflow fallback.

This app-authenticated recovery control is **not independent recovery access**.
The separate recovery login/UI must use different authentication and remain usable
while the app is broken. It is still required, together with full provider adapter
composition, maintenance/quiescence, durable backups, updater upgrades and hosted
upgrade/interruption/recovery acceptance. No app-authentication secret should be
reused as the independent recovery credential.

## Focused evidence and UI review

`node --test tests/updater-service.test.mjs` covers signed service calls into the
actual engine and SQLite updater state, successful staged update progression,
completed-release invalidation, rejected-admission replacement, replay, tampered
and oversized bodies, installation mismatch and current stored Admin authority.
Provider effects are synthetic; these tests are not hosted deployment evidence.
`npm run verify:dashboard` covers existing 41 dashboard checks and its typecheck.
The API typecheck and the focused existing update-info authorization test also pass.

`npm run test:browser -- updates-page.spec.ts` covers lost acknowledgments/reload,
frozen and rejected admissions, terminal job refresh, restoration confirmation and
recovery UUID persistence, unconfigured controls and unchanged physical kiosk
reporting. Four branded screenshots are inspected at 1280x900 and 390x844 in light
and dark themes. Keyboard activation, visible focus, one h1, nonclipping layouts,
44px targets and disabled/restoration states are checked.

The UI reuses `settings-page`, `page-intro`, `panel-heading`, `version-grid`,
`settings-form`, `settings-notice`, `quiet-button`, `primary-button` and
`danger-button`. These inherit existing font, spacing, radius, control and semantic
color tokens; no new CSS values or token exceptions are introduced. Existing
settings navigation outside this surface is unchanged.
