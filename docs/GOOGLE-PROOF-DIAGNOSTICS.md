# Google connection callback diagnostics

The shared connection callback emits one warning on failure with exactly three
fixed fields: `event: google_connection_callback_failed`, `stage`, and `category`.
Success emits no diagnostic. The callback rethrows the original error; its fixed
browser failure redirect, state-cookie clearing, replay protection, session and
Admin checks, candidate revision fences, and consent/promotion behavior remain
unchanged. A logger failure cannot replace the original error.

| Stage | Operation underway |
| --- | --- |
| `admission` | State/cookie, challenge, session, revision and Admin checks; challenge consumption; consent-code presence |
| `code_exchange` | PKCE verifier decryption and authorization-code exchange |
| `identity` | ID-token presence, tokeninfo request and verified identity claims |
| `registered_account` | Active registered Google Admin lookup for login proof |
| `organization_grant` | Organizational token/scope/refresh continuity validation |
| `persistence` | Encrypted candidate write, final authorization/revision fences and audit |

Categories map only recognized internal `GoogleConnectionError` statuses:
400/415 → `invalid_request`, 401 → `authorization_rejected`, 403 → `access_denied`,
409 → `changed`, 413 → `size_limit`, 502 → `provider_failure`,
503 → `unavailable`. Everything else is `internal_error`.
These are application classifications, not raw provider status codes. For
example, Google 400 and 403 responses are already normalized to an internal 401;
this diagnostic does not distinguish `invalid_client` from `invalid_grant`.

The warning never includes an error/message/stack, URL, request or response,
state, authorization code, claims, account identity, client identifier, token,
credential, ciphertext, timestamp, or correlation identifier. All emitted values
come from fixed code constants. Do not broaden the diagnostic with raw provider
errors or request inspection to investigate a failure.

An authorized development tail can observe these records on a fresh consent
attempt. A consumed challenge alone cannot distinguish later failure stages;
the warning identifies the operation that failed without exposing its data.
Consent failure still consumes the challenge where it did previously, so retries
must begin a fresh authorization. This change does not repair or establish the
cause of any hosted failure. Tail invocation, deployment, and real-provider
acceptance belong to the maintainer's separately authorized development work.
