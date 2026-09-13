# Central Google connection (WU-094)

This development backend supersedes the separate-client portion of ADR-013. One Google OAuth client serves staff sign-in and the organizational Calendar/Drive connection. These remain separate purposes, identities, tokens, and proofs. An ordinary staff sign-in never stores organizational access or refresh tokens. The isolated development deployment has completed staff-login and organizational consent, promotion, and Calendar selection. A September 10 readiness read reports shared revision 9 with both purposes verified and Calendar/Drive readiness recorded. Actual Picker selection, Drive persistence and provider transition cases remain separate acceptance gates; saved readiness is not proof of every downstream operation.

## API contract for the dashboard

Routes below are Worker paths; the dashboard uses its `/api` prefix. Every route except the OAuth callback requires a currently active Admin. Mutation JSON is bounded to 4 KiB, rejects unknown fields, and includes the last read `revision`. A 409 means reload; never automatically retry a stale mutation. Responses contain statuses, actual granted scopes and selected calendar label, never client secrets, organizational identity, access tokens or refresh tokens.

| Method/path | Input and result |
| --- | --- |
| `GET /admin/connections/google` | `revision`, `mode`, separate `active`/`candidate` summaries, and both exact callback URIs. |
| `POST /admin/connections/google/candidate` | `revision`, explicit `loginEnabled`, `calendarEnabled`, `driveEnabled`; `clientId`/`clientSecret` required initially. Omit both to reuse the active client for incremental consent or capability changes. Creates a new encrypted candidate, retaining active service. |
| `DELETE /admin/connections/google/candidate` | `revision`; cancels staging and invalidates its pending callbacks. A cancelled legacy migration permits legacy repair again. An installation already promoted to shared mode cannot revert to separate client writes. |
| `POST /admin/connections/google/authorize` | `revision`, `purpose: "login-proof"` with `capabilities: []`, or `purpose: "organization"` with one/both of `calendar`, `drive`. Returns `authorizationUrl` and a Secure/HttpOnly/Lax state cookie. Navigate to the URL; do not show token responses. |
| `GET /admin/connections/google/callback` | Provider redirect only. Success returns to `/settings/integrations?googleConnection=review`; reload status and present the candidate for explicit promotion. Denial/failure returns to the same fixed dashboard route with `googleConnection=failed`, clears the state cookie, and never promotes it. The redirect contains no provider parameters or error details; reload server status before an explicit retry. |
| `GET /admin/connections/google/calendars?revision=N` | Lists up to 100 writable candidate-account calendars. Optional returned `nextPageToken` can be supplied as `pageToken`; tokens are bounded. |
| `PUT /admin/connections/google/calendar` | `revision`, `calendarId`; verifies writer/owner access against Google and records candidate proof. A mistaken candidate-only selection can be changed. Replacement must retain the already active/legacy attendance calendar. |
| `POST /admin/connections/google/promote` | `revision`; checks required purpose proofs, current registered Google Admin proof identity, usable local Admin recovery, unchanged active credentials/observed grant validity/legacy configuration and current initiating Admin in the SQL write. Promotes atomically; removes obsolete legacy credential copies. |
| `DELETE /admin/connections/google` | `revision`, `confirmation: "REMOVE GOOGLE CONNECTION"`; requires usable local Admin recovery, clears shared credentials and candidate/challenges, switches sign-in to local and removes only local attendance Calendar mappings/operations. It does not claim external Google events or account grants were deleted. |

Register exactly these redirect URIs on the one Web application client:

- `https://<development-pages-origin>/api/auth/google/callback` for ordinary staff sign-in.
- `https://<development-pages-origin>/api/admin/connections/google/callback` for explicit connection proofs/organizational consent.

The ordinary sign-in route stays `GET /auth/google/start`. For fresh local-only setup, an Admin may register a Google Admin account first, then prove that Google identity while the initiating local Admin remains the authenticated authority. Organizational identity may be an entirely different account. A local-only installation can enable Calendar/Drive without enabling Google staff sign-in or taking a login proof.

## Proofs, scope and recovery boundaries

Calendar requests `calendar.calendarlist.readonly` and `calendar.events`. Drive requests only `drive.file`. Organizational consent includes OpenID identity so an omitted refresh token can be reused only for the same client and organizational subject. A changed client never inherits an old client's token. Incremental consent sets `include_granted_scopes=true`; only Google's actual reported scopes establish readiness. Requested scopes are not assumed granted. A supplied refresh-response scope set replaces the prior observed set; omission preserves it. Lost scopes are persisted and cannot be recovered by promoting an older copied proof. A provider-proven revoked grant remains encrypted but reports `grantError: revoked` and unavailable capabilities until renewed consent. Temporary failures report `temporary` and remain retryable.

OAuth state is random, hash-stored, installation/purpose/revision/current-Admin/session-bound, ten-minute or initiating-session expiry (whichever is earlier), and consumed before provider I/O. PKCE uses an encrypted ephemeral verifier. The Lax state cookie permits Google's top-level return while the ordinary session stays Strict. When a session cookie is present it must match the initiating session; explicit logout deletes that session's challenges, including during provider I/O. Callback writes recheck challenge existence/consumption/expiry, current Admin and candidate revision in the database. Ordinary login uses its own single-use state/client-generation fingerprint with a maximum of 256 unexpired challenges per installation and expiry cleanup; it has no organizational authority.

Google token/identity/candidate-calendar responses are capped at 64 KiB; existing attendance Calendar bodies at 512 KiB. Provider requests use ten-second aborts, fixed HTTPS provider origins and reject redirects. Provider body text is not copied into errors. These are proposed engineering bounds, verified with local fixtures rather than measured production payload distributions.

The server-only `googleCapability(env, 'calendar' | 'drive')` service checks the shared grant and capability, refreshes centrally, fences generation changes, and reports revocation/scope reductions. Feature modules use this service; they do not keep client secrets or refresh tokens. Attendance retains its existing namespaced event IDs, generations, queues, retry behavior and fixed timing-only payload. Calendar manual retry/sync resolve the shared connection too. Module toggles never touch provider credentials.

`drive.file` allows app-created or explicitly app-selected files, not arbitrary pasted file/folder IDs. Picker authorization and actual Drive upload/copy/publication work belong to following units. No unrestricted Drive proxy or server download endpoint is introduced. Changing an already active attendance Calendar to a different destination remains a separate explicit migration/reset operation; this replacement flow intentionally cannot move existing mappings silently.

WU-115 now supplies the bounded development-only [Picker and Drive feasibility flow](DRIVE-PICKER-FEASIBILITY.md). Its separate online, exact-`drive.file` token may be claimed once by the initiating current Admin for Picker; the combined organizational access/refresh credentials remain server-only. This does not change ordinary login, candidate consent or promotion. Transient experiment settings and runs are excluded from portable backups and must be reconfigured/reverified after restore. Hosted provider acceptance and P4's durable documentation inventory remain separate work.

## Persistence and backup

Migration `0031_google_connection.sql` creates the central row plus separate ephemeral connection/login challenge tables. It does not rewrite existing users, passwords, role/grant rows, Calendar mappings, encrypted legacy credentials or enablement. Legacy delivery and sign-in continue while a replacement is staged. Active and candidate envelopes are authenticated-encrypted with explicit installation/slot context; moving candidate ciphertext into the active slot is rejected.

Installation backup schema 16 includes the central row and persisted grant status/shared-mode marker. Backups 1–15 remain accepted with no central row. OAuth challenges are deliberately excluded and installation restoration deletes them through the installation cascade. Before destructive restore, central ciphertext is decrypted with the installation key, its slot and shape are validated, and active settings/proof/local recovery consistency is checked. Restored candidates lose proofs and organizational grants and receive a fresh generation; they require new verification. Active unavailable grants remain unavailable. Database backup does not copy Drive files.

## Verification

`tests/google-connection-d1.test.mjs` uses actual local workerd/D1 and synthetic provider fakes. It exercises populated migration, distinct legacy clients, registered Google Admin proof from a local Admin, staff-login isolation/replay, actual scopes/omitted refresh, demotion/logout during callback I/O, cancellation, explicit promotion/removal, candidate-to-active backup tampering and restoration, reduced-scope refresh and stage-before-revocation rejection.

The same test invokes the real `PlatformScheduler` Calendar adapter against local D1: one delivered create used **9 D1 statements and 2 bounded provider requests**, below the existing 32-statement/12-request admission ceilings. The emitted event contained only opaque ID, generic summary, start and end. These numbers describe that measured local create case, not a Cloudflare CPU or general payload-capacity guarantee.

Run `npm run verify:api` and `npm run verify:migrations`. The focused API command registers the new D1 test. The dashboard controls below have local verification; live OAuth consent/provider acceptance remains a separate dependency. No external resources or production/Pi operations are performed by this unit.

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google Drive scope boundaries](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Dashboard controls (WU-097)

Admin Integrations implements the contract above. Fresh setup collects one client;
shared replacement may reuse it without credential read-back or stage a different
client. Active and candidate purpose flags, sign-in proof, actual scopes, grant
failure state, capability readiness and Calendar selection remain separate.
Candidate-only changes require cancellation and restaging; existing active service
remains available until verified promotion. Saved legacy providers offer repair
only with no candidate and no shared-mode marker. Cancelling an unpromoted legacy
migration restores that repair path.

The UI reloads after each configuration mutation. A malformed response, changed
revision, failed request or uncertain read-back locks writes until explicit reload;
it never replays a mutation automatically. Failure feedback gives fixed recovery
checks rather than reflecting an arbitrary provider/error response. Password fields
clear on submission. Only the theme uses existing browser storage; credentials,
OAuth state and provider tokens are not persisted or logged by these controls.
Authorization navigates only to the expected Google authorization endpoint with
the exact connection callback. A callback marker only requests status review; it
never establishes readiness or triggers promotion.

Calendar selection loads at most one 100-item server page per user action, replacing
the prior page instead of accumulating it. Shared attendance delivery retains
manual retry/sync, counts and truthful queued/partial outcomes. Unknown or malformed
delivery results require explicit reload. Removal requires the exact typed phrase
and describes the local mapping/queue effects and unchanged external events.

UI review uses existing settings/status/card patterns and shared typography, spacing,
radius, semantic color and 44px control tokens, with no design-rule exception.
Successful staged mutations focus the confirmed status after controls unmount;
error feedback receives focus, while the initial read does not steal focus.
`tests-browser/google-connection.spec.ts` covers fresh setup, proof navigation,
calendar paging/selection, promotion/cancellation/removal, uncertain writes and
read-back, malformed status, callback failure, shared Calendar delivery, and
keyboard/geometry with custom brand colors at 1280x900 and 390x844 in both themes.
Screenshots use synthetic state only. These are local Playwright mocks; live Google
consent, real selected Drive access and isolated development acceptance remain
separate gates. Access settings is the linked registration/local recovery entry.
