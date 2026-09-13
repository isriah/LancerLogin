# Drive Picker feasibility (WU-115)

This P0 development experiment establishes an isolated Picker boundary and a bounded synthetic Drive operation runner. It is not the Activity Documentation inventory, public upload endpoint, packet publisher UI, or completed production migration. No hosted result is implied by local tests.

## Settled requirements and technical defaults

`plan.md` requires one client, separate staff sign-in and organizational grants, explicit file selection with `drive.file`, copied originals, private versions, explicit publication and a stable published PDF link. Native Google Docs remain linked evidence in v1; no inline conversion is promised.

This experiment additionally limits sources to owned My Drive PDFs, PNGs and native Docs whose names begin `LancerLogin synthetic `. Binary sources must be at most 1 MiB. The selected root must be an owner-only private folder, with no shared-drive or shortcut behavior. These are bounded feasibility defaults, not final product upload limits. A synthetic filename is an operator safeguard, not proof that content contains no personal data: the maintainer must create and inspect synthetic sources before selecting them.

## Isolated Picker authorization

The existing shared active client issues a separate authorization code with scope exactly `https://www.googleapis.com/auth/drive.file`, `include_granted_scopes=false`, online access and PKCE. It uses the existing exact `/api/admin/connections/google/callback` URI. A `picker.` random state prefix dispatches to its own table/cookie, independently of login and candidate connection proofs.

The server validates state/cookie, current Admin, session binding, expiration and current connection revision/generation. Callback state is consumed before provider I/O. Token exchange and token-information responses must both report exactly the single Drive scope, valid expiry, and the expected client. Same-account identity is then established using Drive as described below. Additional identity or Calendar scopes are rejected. Unexpected refresh tokens are discarded. The central capability may refresh its existing grant metadata; any resulting IV/revision change safely ends this Picker attempt and requires fresh authorization. Actual narrow-token issuance remains a hosted proof gate.

The encrypted token is claimable once through a current same-session Admin POST, with atomic authority/revision/expiry checks. Claim removes its stored token before responding. Browser memory receives only this separate Drive-only access token, expiry and public Picker configuration. Organizational `googleCapability(...).accessToken()` is used only for server operations; it is never exposed through this flow. The ten-minute cap limits the application claim/Picker session; it does not shorten the underlying Google access-token lifetime. An already released bearer token can remain provider-valid until Google expires it, even after local disposal or Admin demotion. Cancellation/expiry/unmount disposes Picker without invoking provider revocation, which could revoke the wider application grant. No token, provider body, account identity, state or upload-session URL is logged, reflected in redirects or persisted in browser storage.

Provider JSON is bounded to 64 KiB and requests to ten seconds, with manual redirects. JSON requests have a 4 KiB streamed limit and absolute ten-second read deadline. There are at most 32 live Picker intents, one per acting Admin; expiration and obsolete-generation cleanup runs on access. Intents last no longer than ten minutes or the initiating session. Logout deletes its intents, including consumed callbacks still performing provider I/O.

## Admin routes

All paths below are beneath `/admin/connections/google/drive`. All writes include the current shared connection `revision`; stale/uncertain writes require explicit read-back, never automatic mutation retries.

| Method/path | Contract |
| --- | --- |
| `GET /status` | Safe current revision, `configured`, `configRevision`, selected `rootName`, current session intent `{id,purpose,status}`. |
| `PUT /configuration` | `revision,configRevision,projectNumber,browserKey`. Uses the existing restricted browser key and its project number. Invalidates pending selection and root configuration. Public configuration only; not another OAuth client. |
| `POST /picker/authorize` | `revision,purpose:root|source`; returns fixed-provider authorization URL and separate HttpOnly Secure Lax state cookie. |
| `POST /picker/claim` | `revision,intentId`; returns the one-time isolated token and Picker configuration. A lost response requires a new authorization, not reclaim. |
| `POST /selection` | `revision,intentId,fileId,resourceKey?`; organizational token verifies selected file metadata and root permissions. Selection does not mutate Drive. The supplied ID is never treated as proof of access by itself. |
| `POST /feasibility-runs` | `revision,runId,sourceIntentId,confirmation:"RUN SYNTHETIC DRIVE PROOF"`. `runId` is a fresh client-known UUID; retain it before submitting. Allocates five fixed destination IDs and stores the synthetic run. Reusing it is rejected; read its existing state instead. |
| `GET /feasibility-runs/:id` | Returns revision, stage, pending status, offset and safe proof flags; never credentials/session URL. |
| `POST /feasibility-runs/:id/resume` | `revision,runRevision,confirmation:"CONTINUE SYNTHETIC DRIVE PROOF"`; performs one bounded stage/chunk or read-only ambiguity reconciliation. |

The Integrations panel supplies shared Picker setup, selection and explicit staged synthetic proof controls. The authenticated run routes and their controls are for the maintainer's experiment, not a public or staff contribution flow. Admin authority is rechecked in durable writes; concurrent resumes cannot acquire the same run revision. A provider operation can succeed before authority ends: its result remains pending for a later authorized reconciliation instead of falsely committing success.

## Coordinator-only hosted procedure

1. Verify the exact development deployment, existing restricted Picker browser key/project and organizational account. Use no production resource, credential or original file. Prepare an owner-only development root and synthetic native Doc plus synthetic PNG/PDF outside the run's new folders. Configure Picker once, then select that existing root with the organizational account.
2. Complete the isolated authorization and select one synthetic source. Establish that the browser token carries only `drive.file`, while server operations can access the selection through the existing organizational connection. Test an incorrect account and denied consent; existing Calendar delivery and staff login must continue.
3. Generate and retain a run UUID locally, then POST the exact run request once. On any uncertainty GET that UUID; do not issue another create. The request itself generates no file contents yet.
4. Explicitly resume each reviewed stage: create three private child folders; copy source with provenance correlation; upload private PDF; upload separate public PDF; grant anyone-reader permission **only on that public file**; replace its media with different synthetic PDF content; verify private permissions and both content digests. Native copy uses its native MIME type; binary copy must match SHA-256. Source version is checked before and after copying.
5. Deliberately interrupt a chunk response and resume. A pending upload queries the stored session with empty PUT/`Content-Range: bytes */TOTAL`. A `308` Range is inclusive; missing Range means zero acknowledged bytes. Only acknowledged progress is persisted. Completion verifies destination size and checksum. Chunks are 256 KiB; generated test PDFs are about 600 KiB. Session URLs remain encrypted server-side. Never treat 308 as an HTTP redirect or follow its Location.
6. Independently open the published file with an anonymous browser before and after replacement. Confirm the same file ID/link, changed public contents, unchanged private version and inaccessible originals/root/private folders. The runner's `verified` flag means authenticated metadata/permission/content verification; it **does not** establish anonymous browser delivery, link-reader usability or real account policy compatibility.
7. Repeat with the other source type. Record only synthetic IDs and bounded success/failure evidence in the maintainer's private record. Retain failed operation identities for review. Cleanup, if separately authorized, must target the exact generated synthetic IDs; this API never automatically deletes provider files.

Each stage records pending intent before network mutation. Immediately before each write/chunk, current root and destination folder ancestry/owner-only permissions are rechecked. Publication rechecks exact synthetic PDF MIME type, size, digest, parent and operation marker before adding anyone-reader permission. Google permissions and content writes are not one atomic transaction: a concurrent external owner edit after verification remains an explicit hosted limitation; keep the synthetic test tree exclusively controlled during the drill. Do not interpret this as a complete production publication concurrency protocol. Lost native-copy responses search the exact run correlation and private parent; zero/multiple matches remain unresolved, without another copy. A lost upload-init response before its URL is persisted may remain unresolved if the fixed destination is not yet visible. Expired/invalid sessions and partially created folders require maintainer review; this spike intentionally provides no blind restart or generic repair/delete executor. Google Workspace files cannot use the same generated-ID strategy as ordinary uploads. Stable public updates are serialized by the run revision, not advertised as a distributed Drive transaction.

## Persistence, verification and remaining work

Migration0036's three tables are feasibility-only and excluded from portable application backups. Installation restore cascades them away; it never deletes Drive files or changes their permissions. Reconfigure the public key/project and reselect/reverify the existing root after restore. Reconnection invalidates operation access by generation; it does not assert external cleanup. P4 must replace these transient settings with the durable shared configuration and complete artifact inventory/backup model. Database backups do not copy Drive binaries.

Focused tests: `google-drive-picker-d1.test.mjs` checks actual local D1 claims, replay, scope/account/client/expiry rejection and authority loss; `google-drive-proof-d1.test.mjs` covers a complete synthetic graph with lost copy and chunk responses, checksum/version isolation and 308 bounds. Browser mocks in `google-drive-picker.spec.ts` cover setup/read-back, memory-only isolated token handoff, selection, keyboard/focus, malformed status and 1280/390 light/dark branded layouts. They do not contact Google. Run `verify:api`, `verify:migrations`, `verify:dashboard` and the focused browser suite.

Primary references checked during design: [Google authorization scope isolation](https://developers.google.com/identity/oauth2/web/reference/js-reference), [OAuth token information schema](https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest), [web Picker](https://developers.google.com/workspace/drive/picker/guides/web-picker), [resumable uploads and generated-ID limits](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [explicit file permissions](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create).


## WU-135 consumed-callback diagnostics

Dependencies: the WU-115 isolated Picker callback and migration 0036 intent envelope. No new schema, OAuth client, scope, credential or provider request is introduced. The generic browser failure redirect and strict single `drive.file` token/identity checks remain unchanged.

After a callback has atomically consumed its intent, failure may replace that intent's encrypted verifier with fixed `failureStage` and `failureReason` constants. The write checks original intent ID/IV, session hash, generation, exchanging status, expiry, current Admin and connection revision/IV. A failed diagnostic write cannot change the generic failure response. Admission failures before consumption leave no diagnostic. Logout, expiration, replacement authorization, configuration change and obsolete connection cleanup retain their existing behavior.

The current same-session Admin can read `GET /admin/connections/google/drive/status`: its existing `intent` may additionally contain `diagnostic: {stage, reason}`. Reads apply current session expiry/Admin and connection fences and return only recognized pairs, never the encrypted envelope. Another session sees no intent. Old verifier envelopes, malformed diagnostics or decryption failure return no diagnostic. No diagnostics are logged or added to redirects. This is a short-lived development troubleshooting result, not a durable audit trail or an automatic retry signal.

| Stage | Allowed reasons |
| --- | --- |
| `admission` | `consent_declined`, `code_missing` |
| `code_exchange` | `state_unavailable`, `provider_unconfirmed` |
| `token_validation` | `access_token_shape`, `scope_mismatch`, `token_type_mismatch`, `expiry_shape` |
| `token_information` | `provider_unconfirmed` |
| `identity_validation` | `client_mismatch`, `subject_mismatch`, `scope_mismatch`, `expiry_shape` |
| `persistence` | `connection_changed`, `write_unconfirmed` |

Reasons name the check that failed, not provider response contents. `provider_unconfirmed` intentionally groups rejected HTTP responses, unavailable transport and malformed bounded bodies; it cannot distinguish Google's raw OAuth error codes. No code, state, token, provider text, account/client identity, raw scope string or expiry value is persisted in the diagnostic or returned. Authority or connection changes may also prevent its diagnostic write, leaving an exchanging intent without details. Existing consumed intents are not retroactively diagnosed; obtaining evidence requires a separately authorized fresh development attempt.


### WU-137 in-app diagnostic guidance

The Drive selection panel maps recognized WU-135 `intent.diagnostic` pairs to fixed explanatory text in its existing status/live region. It shows guidance after the callback and on Reload Drive selection. Only an `exchanging` intent with exactly the two string fields and a recognized stage/reason pair qualifies; missing, malformed, unknown or stale diagnostics retain the generic status. Provider values are never interpolated. The existing callback/reload focus behavior is retained, with no automatic authorization, claim or provider retry and no new settings. This surfaces evidence for review; it does not establish or repair Google's isolated-token feasibility.

UI review uses existing `ui-status`, integration-card and form/control tokens without CSS exceptions. Focused browser mocks cover desktop 1280x900 and mobile 390x844, light/dark representative branding, reduced motion, keyboard focus, 44px controls, overflow and omission of malformed diagnostics. Screenshots are local synthetic fixtures; hosted guidance acceptance remains a coordinator deployment check.

## Same-account Drive identity (WU-138)

The callback no longer assumes OAuth2 v2 tokeninfo `user_id` equals the central OIDC subject or is available with exactly `drive.file`. After the unchanged client, scope and expiry checks, it calls `GET https://www.googleapis.com/drive/v3/about?fields=user(permissionId)` separately with the isolated token and the organizational token from `googleCapability(env,'drive')`. Both returned opaque IDs must match exactly and be 1�256 ASCII letters, digits, underscores or hyphens. IDs remain transient server memory, without logging or persistence. Missing/malformed identity, provider failure and a different account fail closed before browser release.

This is a technical identity-verification change, not another OAuth client or expanded browser permission. Google documents [about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get) as accepting `drive.file`, and [User.permissionId](https://developers.google.com/workspace/drive/api/reference/rest/v3/User) as the Drive user's permission identity. The captured capability generation and encrypted-row IV must match the original intent authority; refreshed metadata is checked before the reads and the final atomic Admin/revision/IV fence remains authoritative. Benign grant refresh that rotates the IV requires a safe retry.

The fixed `drive_identity` diagnostic stage contains only `provider_unconfirmed`, `identity_invalid`, `account_mismatch` and `connection_changed`. Historical `identity_validation/subject_mismatch` remains readable for old consumed intents. Local D1 tests cover absent/different tokeninfo IDs with matching Drive identity, foreign/malformed/provider responses, rotation, replay and unchanged scope/client checks. Hosted acceptance is separate.


### WU-139 staged development proof controls

The existing Drive panel now invokes the staged run routes through the same authenticated browser session that selected the source. Creating a run requires explicit confirmation and a still-selected source intent. Before its one create POST, the browser writes and reads back the client-generated run UUID in a bounded 16-ID local history. Storage failure prevents the POST. Only UUIDs are stored; these are development run identities, not session secrets or provider credentials. The backend continues to authorize current Admins by active connection generation, including another Admin reviewing a saved run ID.

Reload restores the most recent saved ID but makes no proof request automatically. Read proof status obtains the current run revision before continuation. Lost create/resume responses retain the ID, clear usable state and require readback; the UI never retries a mutation or creates a replacement for an unresolved ID. Invalid summaries or unexpected public URLs also clear usable state. A new run is offered only after the latest recorded run has been read as complete. No arbitrary cleanup/reset is provided; unavailable runs need maintainer review.

Every stage or upload chunk requires a fresh checkbox confirmation. The review describes private folder creation, source copying, private and public-candidate uploads, anyone-with-link publication of only the separate synthetic PDF, replacement at the same file ID/link, and permission/checksum verification. Pending steps are explicitly labeled for reconciliation. Source intents expire within ten minutes, but an existing recorded run does not need a fresh source selection. Connection revision changes invalidate local freshness and require readback. Buttons share an in-flight lock with the parent Picker controls; reload/unmount retains saved identity without continuing work automatically.

Local browser mocks cover separate confirmations, exact request revisions, identity persistence before create, lost responses, expired source after creation, storage failure, malformed readback, duplicate clicks, connection changes and in-flight reload. Visual review uses the existing Google panel/checkbox tokens, status focus, native controls and 44px buttons at 1280x900 and 390x844 in light/dark custom branding with reduced motion. This is local/mock verification, not hosted provider acceptance; anonymous public-link checks and private-file access checks remain separate coordinator actions.
