# Independent recovery surface

WU174 provides a standalone recovery service and HTML page on the installation's pinned, independent HTTPS updater origin. It requires no application API, application cookie, dashboard assets, GitHub connectivity, or third-party browser assets. This is a local composition foundation; provisioning the independent origin, credential custody, and production bootstrap remains outstanding.

`createRecoveryService({ engine, store, database, capability, installationId, origin, credentialSha256, now })` in `apps/updater/recovery-service.mjs` composes the real updater engine and updater-state D1. Apply `apps/updater/state/0004_updater_recovery_sessions.sql` to updater state, never the application database. The trusted bootstrap supplies the engine capability, HTTPS origin and installation pin. Recovery uses the engine's captured prior release and retained artifacts; it cannot choose a new release or change infrastructure resources.

Provision a separate credential of exactly 32 cryptographically random bytes represented as 64 lowercase hexadecimal characters. `recoveryCredentialDigest(credential, installationId)` derives the installation-domain SHA-256 digest accepted by the factory. This is a high-entropy credential, not a human password; no password-hardening claim is made. Never reuse the application authentication secret. Keep credential generation, custody, rotation and revocation in the eventual provisioning process. Rotation must also revoke existing updater recovery sessions.

## HTTP contract

All paths are relative to the pinned updater origin. Responses are no-store with fixed safe errors; no signed manifests, artifact URLs, credentials, provider content or deploy authority are returned.

| Method/path | Request |
| --- | --- |
| GET `/recovery` | Standalone login and recovery page |
| POST `/recovery/session` | Exactly `{ credential }` |
| GET `/recovery/status` | Authenticated read-only refresh |
| POST `/recovery/advance` | `{ jobId }` |
| POST `/recovery/retry-preparation` | `{ jobId, failedOperationId }` |
| POST `/recovery/recovery` | `{ requestId, failedJobId, mode, confirmation }` |
| POST `/recovery/logout` | `{}` |

POST requests require the exact Origin and JSON content type, fixed action schemas and at most 4 KiB. Authentication uses a random 15-minute `__Host-lancerlogin_recovery` Secure, HttpOnly, SameSite=Strict cookie; only its installation-domain digest is stored. Authenticated POSTs additionally require the status response's `csrfToken` in `x-recovery-csrf` and a fresh UUID in `x-recovery-nonce`, claimed atomically in updater D1 before invoking the engine. Replays fail. Login attempts use a durable installation-only budget of ten attempts per trusted-clock minute, without IP or personal data. CSP limits scripts/styles to response nonces and connections to the independent origin.

Status adds `expiresAt`, CSRF token and the latest `{ requestId, state }` recovery receipt to bounded engine status. Job request identity is returned only when the engine status and stored job IDs agree. Recovery modes are `code-recovery` with exact `RECOVER APPLICATION CODE`, or `restore` with exact `RESTORE APPLICATION DATABASE`. Database restoration remains unavailable unless the actual engine backup and write-quiescence adapters permit it. Refresh never advances a job; explicit continuation preserves pending/reconciling operation semantics.

## Lost responses and browser behavior

Before dispatch, the browser stores only the recovery request UUID, failed job UUID and mode in local storage. It clears the credential input before login dispatch and never saves the credential. Reload retrieves the authenticated current job. A matching accepted job or a matching definitive accepted/rejected receipt clears the saved request; transport failure or elapsed time does not. Retries use the frozen recovery request identity with a fresh transport nonce. Durable pending requests are read back rather than blindly admitted again. An unresolved request claim therefore requires trusted operator investigation if no definitive engine job or rejection can be established.

The self-contained page supports keyboard focus, 44-pixel controls, light/dark preferences and a narrow layout. It displays installed state, current operation, safe failure text, explicit preparation retry and continuation, code recovery and typed database restoration confirmation. No automatic mutation or application authentication is involved.

## Focused verification

Run `node --test tests/updater-recovery-service.test.mjs tests/updater-recovery-browser.test.mjs` with the existing workspace dependencies. The SQLite fixture uses the production engine, signature verification, portable archive reader and encrypted checkpoint codec with ephemeral signing and recovery identities. It fails deployment after capturing a prior release, then makes the release source unavailable and completes retained-code recovery. Tests cover origin/CSRF/replay, exact confirmation, unavailable restoration, expiry, bounded bodies/login attempts, credential separation and mobile keyboard login plus lost-request reload identity. Chromium routes only the independent origin to the real service fixture; no application server runs.
