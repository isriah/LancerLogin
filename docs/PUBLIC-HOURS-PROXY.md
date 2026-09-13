# Public Hours proxy provenance (WU-112)

This is a server-to-server admission protocol; it grants no member identity or accounting authority. Public request/receipt contracts remain in PUBLIC-HOURS-API.md. No new resource, migration, provider destination or browser credential is introduced.

## Trusted ingress and privacy

Pages signs only public Hours GET/POST traffic when its platform Request has an object `cf`, no `CF-Worker` header, and a single canonical IPv4/IPv6 `CF-Connecting-IP`. It rejects malformed addresses and the cross-zone Worker sentinel. Incoming assertion headers are always removed before generating one. Same-zone Worker subrequests are excluded because their connecting IP can derive from mutable `x-real-ip`; cross-zone Worker traffic has a sentinel. Cloudflare documents `CF-Worker` on all Worker fetch subrequests. A caller-supplied CF-Worker can only force the restrictive fallback. These rules rely on Cloudflare overwriting the ingress connecting-IP header; arbitrary reverse proxies must not be installed ahead of this trust boundary. [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/), [Request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/).

Requests with missing metadata, absent/malformed key, any Worker ingress, invalid/stale assertions or changed bindings use the existing shared unverified-source quota. They never obtain a bucket from forwarded headers or browser input. API responses do not reveal whether an assertion verified. Raw addresses, tokens and assertions are not logged, reflected, persisted in the database, or included in backups. The existing transient D1 limiter stores another purpose-derived hash; its cleanup/restore behavior is unchanged.

## Version 1 wire contract

All JSON values below use JSON.stringify array encoding and UTF-8. Base64url is unpadded and canonical. HMAC and SHA use SHA-256. Keys are 32 bytes.

- Derived Pages key: HMAC using API `SESSION_KEY`, over `['lancerlogin-hours-proxy-key',1,installationId,exactPagesOrigin,exactApiOrigin]`. The API derives it for verification; only its result is provisioned as Pages `HOURS_PROXY_KEY`.
- Source token: HMAC using that derived key over `['lancerlogin-hours-source',1,floor(timestamp/86400000),canonicalAddress]`.
- Payload: `[1,timestamp,method,SHA256(canonicalPathAndQuery),SHA256(exactBodyBytes),sourceToken,exactPagesOrigin,exactApiOrigin]`. Both digests are lowercase hex. Canonical path/query is the URL parser's pathname plus search on the exact API target, preserving query order/encoding; it is not reconstructed from decoded parameters.
- Header `x-lancerlogin-hours-assertion`: base64url(payload JSON) + `.` + base64url(HMAC(derived key, `['lancerlogin-hours-assertion',encodedPayload]`)). The API uses WebCrypto MAC verification before interpreting payload claims.

Engineering bounds: assertion <=1024 characters; canonical target <=8192 characters (comfortably includes existing bounded Unicode searches); freshness 30 seconds, future skew 5 seconds, same UTC day. A midnight-boundary request falls back instead of introducing a previous-day source bucket. These are tested defaults, not measured Cloudflare limits. POST bodies are streamed with a 16 KiB ceiling and one absolute 10-second read deadline at each hop; cancellation is not awaited. GET bodies and unsupported methods are refused. Exact Origin is required for writes. Signature freshness is evaluated after the API finishes reading; the accounting domain receives a fresh trusted server time afterward, preserving reopening expiry.

This is not a nonce or anti-replay protocol: a byte-identical assertion can be replayed during its freshness window, and each replay consumes admission quota. Existing immutable domain idempotency prevents duplicate accounting; a changed body/method/path/origin fails authentication and uses fallback. Do not add automatic retries. The public proxy uses manual redirects so it cannot forward assertions to another destination. Ordinary attendance/auth/API proxy paths retain their prior forwarding behavior.

## Development provisioning and rotation

Only the already approved `lancerlogin-v2-example-dashboard` Pages project is supported by the development helper. `prepareHoursProxySecret(identity, savedSecretsPath, outputPath)` from scripts/development-bundle.mjs is local-only: it validates fixed destination identities, reads the existing saved API SESSION_KEY under ignored `.provision`, and writes the derived key once with exclusive creation and mode0600 (on Windows, a protected current-user-only DACL is applied before writing the secret). An ACL failure leaves an empty file and fails closed. It neither generates an API key nor calls Cloudflare. It returns candidate metadata `{protocol,project,secret,keySha256,approval:false}` without the key. The key fingerprint hashes the exact unpadded base64url secret text.

Coordinator procedure:

1. Verify the saved SESSION_KEY corresponds to the exact development API; do not rotate it as setup shorthand. Call the local helper with a fresh ignored output filename. Independently review the exact account, Pages project and both origins.
2. Record `identity.hoursProxy` outside Git as `{protocol:'hours-proxy-v1',project:'lancerlogin-v2-example-dashboard',secret:'HOURS_PROXY_KEY',keySha256:<reviewed fingerprint>}`. Candidate `approval:false` is not approval and is not copied into that object.
3. With the existing resource authorization, set only the production-environment `HOURS_PROXY_KEY` secret on that exact development Pages project from the local file. Preserve unrelated environment variables. Do not expose SESSION_KEY to Pages, browser builds, command arguments, logs or screenshots. No automatic provider write is provided by this unit.
4. Package a newly reviewed immutable bundle. Its manifest pins the approval metadata; bootstrap reads the exact Pages project's production env_vars before any secret upload and again before API/Pages deployment. Missing/wrong-type secret, wrong project, malformed provider response, omitted opt-in or local key/fingerprint drift fail closed. Legacy artifacts cannot silently drop enabled configuration. The helper never updates Pages env_vars. The read shape follows [Cloudflare Get project](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/).
5. Coordinator performs hosted acceptance after deployment: normal browser traffic must create a verified-source bucket separate from the direct API fallback, using only bounded count/boolean evidence with no addresses/hashes/assertions logged. Verify spoofed headers remain fallback, public responses remain generic, and ordinary attendance still works. Secret presence cannot prove a masked remote value; actual functional verification is required before claiming setup or rotation succeeded.

For a deliberate API SESSION_KEY rotation, derive and privately approve the new fingerprint, separately replace only the derived Pages secret, rebuild the approved bundle and repeat functional acceptance. A temporary mismatch stays on restrictive fallback. General installations use their own exact origins and installation ID with the same derivation, and must supply this equivalent secret setup before claiming source partitioning. Custom domains change the derivation and require explicit reprovisioning; preview origins do not inherit authority for the approved production origin.

## Verification boundary

Local tests exercise the actual generated Pages worker, shared cryptographic implementation, public API, actual local D1 admission and mocked provisioning. Hosted Cloudflare header provenance, remote secret value, deployed CPU/time and provider permissions remain coordinator acceptance work. No external resource or live deployment was changed by WU-112.
