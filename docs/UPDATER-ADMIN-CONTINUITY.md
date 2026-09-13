# Exact-admission Admin controls (WU194)

Dependencies: WU172 service authentication, WU183 maintenance facade, WU185 runtime, WU189/193 foreground progress. Apply updater-only migration0008 before composing this runtime. No application migration or provider provisioning is included.

The runtime exposes `controls.fetch` on the pinned independent updater origin. Keep the raw engine and `controls.grant` private. Only the authenticated application service invokes grant after verified HMAC actor extraction; existing stored-Admin API authorization remains the final start authority. The controller cannot start an update, select another release, restore data, or renew authority.

## Admission and handoff

Settings freezes the existing request UUID/release, opens `/control`, obtains `control-grant` through the current stored-Admin application API, then sends the one-use secret with postMessage to that exact window and exact pinned HTTPS origin. The receiver checks its opener and pinned dashboard origin. Cookie confirmation and returned request identity precede the original Admin-authenticated `start`. A later demotion still denies that start. Grant secrets never appear in URLs, local/session storage, logs, or returned status. Browser provider credentials and recovery credentials are never involved.

One updater control row owns an immutable installation/request/actor/release identity/dashboard-origin tuple. Conditional grant replacement checks absence of admission in the same SQL statement and invalidates its previous session. Exchange consumes the60-second grant and installs the900-second absolute session hash/CSRF atomically in that same row. Admission is conditional on matching actor, release and an exchanged unexpired session when a grant row exists. Legacy admission without a grant remains compatible; existing admission cannot later obtain a new grant. Only pre-admission grant replacement is supported; sessions cannot renew.

The session cookie is Secure, HttpOnly, SameSite=Strict, host-only and Path=/. Mutations require the pinned Origin, JSON bounded by the shared request limit, exact action schema, CSRF and a unique nonce. An atomic indexed row counter permits4096 authenticated action attempts per session; duplicate nonces consume an attempt and never dispatch. Nonce uniqueness uses its primary key, without scanning prior attempts. Trusted time enforces the absolute expiry.

`GET /control/status` is read-only and resolves only the exact admission. It never substitutes a newer current job. `POST /control/advance` and `/control/retry-preparation` authorize the same persisted admission/job before calling the maintenance facade. Recovery availability is suppressed: privileged recovery requires the independent recovery link and separate credential. Logout and final reopening advance erase the session hash. Expiry, changed recovery lineage, rejected admission or an already-open completed job deny further scoped authority based on persistent state; GET does not mutate session storage.

Both `/control` and `/recovery` public HTML shells allow cross-site navigation from the dashboard. Their authenticated APIs retain cross-site denial and all Origin/session/action guards. Shells contain no session/private data. No frame embedding or third-party assets are used.

## Lost replies and progress

The dashboard bridge binds its active window to request UUID/release and disposes listeners/timers on definitive rejection, ended session/job, logout or closed window. It can reconnect to an existing cookie for the same request before requesting a replacement pre-admission grant. Unknown start acknowledgment retains the original UUID; no timeout admits another job. A lost exchange without a usable cookie can replace its grant only while admission is absent. Status/error relay strips CSRF. Missing/expired control authority falls back to the separately authenticated recovery surface.

The independent controller reuses the existing explicit foreground driver:250ms confirmed-step gap, visibility pause, read-before-retry, uncertainty backoff, explicit reauthentication after900s. It does not automatically arm on handoff or refresh. The dashboard can manually advance while maintenance closes application authentication and retains Finish reopening until maintenance is open, with an explicit finishing message. Large jobs may outlive the absolute session and require independent recovery. No scheduler or hidden automatic continuation is added.

## Candidate evidence and limits

- Actual SQLite engine/auth tests cover immutable actor admission, one-use grants, replacement, expiry, nonce replay, exact job scope, read-only status and cross-site shell/API boundaries.
- Headless Chromium runs the actual compiled dashboard bridge against the control service, proves cookie confirmation/request identity, exact-job advance, logout cleanup, no credential storage, and keyboard/mobile layout.
- Existing Updates-page six-case acceptance plus a focused terminal-reopening regression covers frozen admission/recovery IDs, polling, light/dark/custom-brand1280x900 and390x844. Dashboard41 tests plus TypeScript pass. No CSS/token changes; touched notice uses existing `ui-status settings-notice`. Independent shell deliberately uses system fonts/native controls without application assets. Live progress/notice text changes only when its value changes.
- Actual runtime fixture captures/replays1000 operational audit rows, migrates46 to49, then updates49 again using the same validation resource and preserved historical backups.649/841 advances; measured binding peaks46/45 (coincident5 Fetch), separate Fetch peak8; admission42 bindings and12 Fetch. SQL statement peak81 includes atomic migration batches and is not a D1 rows-read count. No hosted quota or latency measurement is claimed. The250ms pacing contribution alone is about162/210 seconds; network/storage latency adds to it. This does not guarantee completion inside900s.
- Grant/exchange are separate bounded requests preceding measured start; the profile does not add their cost to the start invocation. Bindings, SQL executions and Fetch counts are reported separately; their sum is diagnostic, not asserted as one platform limit.

Commands: `node --test tests/updater-control.test.mjs tests/updater-control-browser.test.mjs tests/updater-service.test.mjs tests/updater-recovery-service.test.mjs`; `node --test --test-name-pattern="profiles delegated" tests/updater-runtime.test.mjs`; `npm run verify:dashboard`; `npm run test:browser -- tests-browser/updates-page.spec.ts`.

Actual routing of `/control` and the private application binding, secret custody, trusted origins and cloud deployment remain bootstrap work. No restoration permission, broad maintenance authentication exemption, automatic renewal or cloud operation is introduced.
