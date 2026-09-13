# Private immutable application release source

WU-170 implements the independent updater's concrete GitHub read transport in
`apps/updater/github-release-source.mjs`. Dependencies: WU-168 signed application
bundle/verifier, separately provisioned installation trust and a dedicated
server-only read credential restricted to the approved private repository. No
credential is loaded or provisioned by this module. No release is published.

The adapter uses the documented GitHub REST
[repository identity](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[published release metadata](https://docs.github.com/en/rest/releases/releases#get-a-release),
and [release assets](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)
endpoints with API version `2026-03-10`. GitHub documents the `immutable` release
field and supports downloading an asset through `application/octet-stream`,
either directly or through a redirect. Fine-grained private release reads require
repository **Contents: read**; credential scope must be provisioned externally.
The adapter cannot infer whether a supplied token also has unnecessary writes.

## Server interface

```javascript
const source = createGitHubReleaseSource({ pins, token });
const availability = await source.available(installedState, savedDiscoveryProgress);
// If status is 'checking', persist availability.progress and continue in a later
// invocation. Only 'available' is a complete positive availability result.
// Persist the selected identity in updater-owned durable state before staging.
const release = await source.resume(availability.identity);
const apiBytes = await source.download(release, 'api.mjs');
const dashboardBytes = await source.download(release, 'dashboard.tar');
```

`pins` has exactly the WU-168 verifier's product, channel, numeric repository ID,
case-sensitive owner/name, key ID and raw public key. Construction snapshots these
pins. `fetch` can be injected for synthetic tests; production uses standard Fetch.
`deadlineMs` is a trusted construction limit of at most 30 seconds per operation,
including all metadata, redirects and response-body reads. No automatic retries
occur. Native fetch, parser and verification errors become fixed `source-*` codes;
upstream content, credentials and signed URLs never appear in those errors.

- `candidates()` returns at most 30 recent immutable published release IDs. This
  is only a discovery hint and must never be presented as verified availability.
- `available(installedState, progress = null)` captures the bounded candidate ID
  list once and inspects **one candidate per invocation**. Until all candidates
  have been checked, it returns `{ status: 'checking', checked, total, progress }`.
  Persist this progress in updater-owned storage and pass it to a later invocation;
  it must not come from the browser. Progress is bound to the exact installed-state
  and trust snapshots; changes reject the stale scan with `source-checkpoint`.
  Each candidate is verified under the pinned channel/key/repository and evaluated
  against compatibility/high-water/ledger checks. Only after the entire captured
  list has been examined does it re-resolve the exact winning identity and return
  the highest compatible **signed sequence** as `{ status: 'available', identity,
  version, sequence }`, or `{ status: 'no-compatible-release' }`. Invalid signatures
  and incompatible manifests are not advertised. A provider/deadline/membership
  failure rejects that invocation instead of returning a partial best result.
  Continue only from the last saved progress; never replace it with a fresh latest
  list. At the maximum 258 assets and one redirect per manifest/signature download,
  an invocation makes at most 30 provider requests, including final winner
  revalidation. The caller supplies valid updater-owned installed state.
- `resolve(releaseId)` selects one explicit positive numeric ID and returns an
  opaque live handle containing `identity`, exact `manifestBytes` and raw
  `signatureBytes`. The signed bytes are transient internal staging data, not a
  public status response. The release tag must be `v` followed by the signed
  numeric version; channel selection remains a signature pin.
- `resume(identity)` snapshots and re-resolves the exact persisted release ID,
  then compares every identity field. It never consults latest or substitutes a
  different release after a restart.
- `download(handle, artifactName)` accepts only a handle from this source instance
  and a signed artifact basename. It rechecks repository identity before access,
  bounds the download, verifies the signed byte length/SHA-256 and validates the
  canonical dashboard archive when applicable. It returns private byte copies.
  It does not accept arbitrary asset IDs, URLs, commands or application trust.

The serializable frozen identity contains format, pinned repository/channel,
release ID, tag, manifest/signature digests and the exact sorted asset IDs,
basenames, lengths and digests. It contains no token, provider URLs or artifact
contents. Persist it only after authorized updater job admission; callers must
also reverify persisted staged artifact bytes before deployment. A source handle
does not survive serialization; recreate it with `resume`.

## Provider boundary and limits

Before release access, GET the fixed owner/name repository endpoint and require
the numeric ID, owner/name and private flag to match. Renamed, transferred,
recreated or public repositories fail closed. Require the exact release ID,
`immutable: true`, published date, `draft: false` and `prerelease: false`.
Enumerate the release's complete asset list in fixed numbered 30-item pages,
bounded to 258 assets (256 signed artifacts plus manifest/signature). Reject
duplicate names/IDs, incomplete or extra assets, non-uploaded states and mismatched
lengths. Metadata URLs and browser download URLs are ignored entirely.

Only fixed `https://api.github.com/repos/{pinned owner}/{pinned name}/...` URLs
receive the GitHub bearer token. API metadata redirects are refused. Asset
downloads permit at most one absolute HTTPS redirect to the exact host
`release-assets.githubusercontent.com` or `objects.githubusercontent.com`, with
no credentials, nondefault port or fragment in the URL. The second request has
fresh headers and no authorization/cookies/referrer; further redirects fail.
This explicit host allowlist is an implementation restriction, not a promise
that GitHub will never change its storage hosts. A changed provider route requires
review rather than broadening access automatically. Signed URLs remain ephemeral.

Provider JSON is separately bounded to 8 MiB with strict UTF-8 decoding and native
JSON parsing because GitHub release listings embed full asset metadata for all
30 candidates. Signed manifests retain the unchanged 128 KiB strict verifier
parser (including duplicate-key rejection); signatures remain bounded to 64 bytes;
each artifact to its signed size and at most 16 MiB.
Content-Length is checked early, but a missing/incorrect header never removes the
streaming byte limit. Readers are cancelled on overflow/deadline. The adapter
downloads one artifact at a time; the v1 verifier bounds the signed aggregate to
64 MiB. The orchestration caller controls durable storage and staging cadence.

The source trusts the publisher's signed source/compatibility declarations; it
does not reproduce builds or validate SQL semantics. GitHub immutability plus
signatures does not acquire an update lock, authorize an Admin, create a backup,
apply migrations, deploy code or prove recovery. Those remain engine/provider
adapter requirements. Discovery currently considers only the most recent 30
releases; an older intended release requires an explicit ID. Automatic scheduling,
live private asset acceptance and immutable publication remain separate work.

## Focused verification

`node --test tests/updater-release-source.test.mjs` uses ephemeral synthetic
Ed25519 keys and injected Fetch responses with real signed API/tar artifacts. It
covers incremental highest-compatible discovery across 30 schema49 releases with
realistic embedded asset metadata and bounded per-invocation requests, stale-state
progress rejection, exact resume, numeric repository and
immutability rejection, asset membership, token stripping and redirect rejection,
stream cancellation, tampering, signed-but-unsafe archives, fixed errors and
deadlines. It performs no network request or live credential read. Hosted GitHub
interoperability remains an acceptance gate, not implied by these local cases.
