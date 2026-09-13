# Worker provider redirect compatibility

WU-104 repairs a reproduced runtime incompatibility. Installed workerd
`1.20260828.1`, with compatibility date `2026-08-01`, rejects a Request using
`redirect: 'error'` before issuing the request. The shared Google callback caught
that exception as `code_exchange` / `provider_failure`. Node fetch mocks had
accepted the option and therefore missed the failure.

Worker provider requests now use `redirect: 'manual'`. Shared Google, ordinary
Google sign-in, Calendar API/legacy refresh, and Discord reject 3xx responses
before reading their bodies. They never fetch the Location destination or
forward credentials to it. Telemetry retains its existing `.ok` success gate,
so a manual 3xx response is an unsuccessful delivery. Node provisioning and
maintenance tools are unchanged.

Non-redirect HTTP classification, retry counts/delays, scheduler admission,
timeouts, response limits, OAuth state/PKCE/identity checks and candidate
promotion rules remain unchanged. No diagnostics are expanded and no provider
payload, URL, parameter, credential or error is logged.

The focused Google test now executes production callback code in actual local
workerd with entirely synthetic persistence and an outbound service intercepting
every request. It checks form encoding, the real timeout signal, streamed JSON,
successful proof, denied/rate-limited responses, malformed/oversized bodies,
token and identity redirects, and timeout failure. A representative production
Discord transport runs in the same runtime. Unexpected outbound destinations
are counted and rejected; no Google or Discord service is contacted. Existing
local D1 tests continue to verify actual persistence/security boundaries.

The baseline regression demonstrates workerd rejecting the old request option.
The fixed runtime path demonstrates reaching the synthetic provider and reading
its response. This establishes the local cause and repair; it does not establish
that any hosted account/client is ready. The maintainer must deploy the reviewed
bundle and perform a fresh authorized development consent attempt. Prior failed
authorization codes/challenges must not be replayed.
