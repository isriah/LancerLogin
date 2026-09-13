# P0 release trust feasibility

WU-090 establishes a local signing and verification contract. It does not implement
the P6 updater, authorize a deployment, or complete P0 acceptance. The confirmed
product requirements remain those in `docs/V2-STATUS.md`: centrally built signed immutable
releases, pinned installation resources/source/trust, an independent updater and
recovery surface, and no application access to deployment credentials.

Dependencies: P0's proposed signing contract in
`docs/V2-STATUS.md`. Production key custody, private release-asset
access, durable updater state, release packaging, migration recovery and live
development deployment verification remain separate dependencies.

## Implemented technical defaults

`experiments/release-trust/verifier.mjs` uses standard WebCrypto `Ed25519` and
`SHA-256`, with no Node imports, provider requests, credential reads or mutations.
Cloudflare documents support for these algorithms in its
[Workers Web Crypto reference](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
The experiment uses the standard `Ed25519` algorithm, not the legacy
`NODE-ED25519` variant.

The signed message is the UTF-8 bytes of `LancerLogin release manifest v1`, one
literal LF byte (`0x0a`), followed by the **original manifest bytes**. The detached
signature is exactly 64 raw bytes. Bootstrap supplies the pinned 32-byte raw public
key and its key ID. JSON is never parsed and serialized again to construct the
verification message. Whitespace changes invalidate an existing signature; a
separately signed formatted manifest is valid and has its own manifest digest.
The SHA-256 checkpoint identity hashes the original manifest bytes without the
domain prefix. There is no signature envelope or algorithm negotiation.

The verifier snapshots the public key and source pins at construction. It snapshots
manifest/signature/artifact input before any asynchronous operation. Verified
manifests are deeply frozen and registered in a private `WeakSet`; a fabricated,
serialized or another verifier's handle cannot be used to assess an update or
verify artifacts. Reverify a stored manifest after a process restart.

Parsing rejects malformed UTF-8, a UTF-8 BOM, invalid JSON, duplicate decoded
object keys at every depth (including escaped spellings), trailing content, nesting
deeper than 12 and more than 20,000 JSON values. The schema rejects missing or
additional fields at every object boundary. Error messages are fixed codes and
do not echo manifest content.

These version-one limits are proposed defaults, not measured Cloudflare capacity:

| Limit | Value |
| --- | --- |
| Manifest bytes | 128 KiB |
| Artifacts | 256 |
| One artifact | 16 MiB |
| Sum of artifact lengths | 64 MiB |
| Target schema / migration count | 254 |
| Release sequence / repository ID | Positive JavaScript safe integer |
| Version syntax | Three numeric components, no `v`, prerelease or build suffix; at most nine digits per component |

Development uses its separately pinned channel with ordinary numeric versions.
If release packaging needs prerelease versions or larger artifacts, extend the
contract deliberately and rerun compatibility/resource measurements. The current
helper hashes one bounded in-memory artifact; it does not prove 16 MiB processing
fits a deployed Worker CPU budget. Callers must bound a download **while reading**
it, before passing bytes to this helper.

## Signed schema

All fields below are required. Product is exactly `LancerLogin`, format is `1`,
and kind is exactly `application`.

| Field | Contract |
| --- | --- |
| `channel`, `keyId` | Exact bootstrap pins; bounded lowercase identifiers |
| `repository` | Exactly `{ id, owner, name }`; all three equal their bootstrap pins, including case |
| `sequence`, `version` | Monotonic release sequence and numeric application version |
| `sourceCommit` | Lowercase 40-character Git commit ID, signed by the publisher |
| `minimumUpdaterVersion` | Minimum numeric updater version |
| `compatibility.installedVersion` | Inclusive `{ min, max }` supported installed application versions |
| `compatibility.installedSchema` | Inclusive `{ min, max }` supported installed schemas |
| `compatibility.apiVersion` | Positive API protocol version |
| `compatibility.apiSchema` | Inclusive schemas the target API can operate against |
| `compatibility.frontendApi` | Inclusive API protocol versions accepted by the target frontend |
| `targetSchema` | Final schema number; must be supported by the API |
| `codeRollback` | `compatible` or `restore-required`, describing rollback from this upgrade |
| `artifacts` | Exactly one `api` (`.mjs`), one `dashboard` (`.tar`), and zero or more `migration` (`.sql`) descriptors |
| Each artifact | Exactly `{ role, name, bytes, sha256 }`; unique bounded basename, positive bounded length and lowercase SHA-256 |
| `migrations` | Complete ordered chain from schema zero to target, rather than only pending migrations |
| Each migration | Exactly `{ id, fromSchema, toSchema, artifact, sha256 }`; contiguous one-step transition, unique `NNNN_name.sql` ID and artifact, matching signed artifact name/digest |

The full migration chain permits comparison with a trusted installed digest ledger.
Names cannot carry paths or URLs. No descriptor can name an updater artifact.
Fields for commands, bindings, resource identities, trust roots, credentials or
artifact URLs are rejected, even when correctly signed. A future separately typed
updater-upgrade contract must not be routed through this application verifier.
The schema and signed declarations do not inspect what executable code does; P6
must preserve the independent updater boundary and never supply infrastructure
credentials or writable updater state to an application Worker.

## Update versus code recovery

`verify()` validates bytes, schema, source pins and signature, returning a verified
handle and exact-byte digest. `verifyArtifact()` accepts only a descriptor from
that handle and checks its exact byte length and SHA-256. It returns a private
copy of the verified bytes; future staging must retain those bytes unchanged and
reverify persisted content before use.

`evaluateUpdate()` consumes a **trusted updater-owned** installed state containing
version, schema, updater version, highest accepted sequence and ordered migration
ID/digest ledger. It rejects sequences at or below the high-water mark, versions
at or below the installed version, old updaters, incompatible installed versions
or schemas, and changes to historic migration IDs/digests. Its result identifies
only the pending suffix of the verified migration chain.

`evaluateCodeRecovery()` is a distinct interface. The independent updater must
supply a previously persisted, verified checkpoint containing the prior manifest
digest, sequence, version and target schema, plus the interrupted upgrade's
rollback classification. This is **not** request data or an assertion supplied by
the application. The target's exact signed manifest must match that checkpoint,
the prior sequence must already be below or at the retained high-water mark, and
the prior API must support the current schema. The interrupted upgrade must be
classified `compatible`. Successful evaluation performs no migrations and retains
the original high-water mark. `restore-required` rejects code-only recovery;
database restoration is not implemented by this experiment.

Both evaluations are compatibility results, not mutation authorization. They do
not download or check that every artifact is already staged, authorize an Admin,
acquire a lock, persist the sequence, apply SQL, preserve bindings, inspect a tar
archive, publish a deployment or check health. P6 must enforce those boundaries
and persist/reconcile checkpoints under an exclusive updater-owned job before
any external mutation. API/frontend range metadata describes the target pair;
safe mixed-version deployment ordering still requires checking the current pair
or entering explicit maintenance mode.

## Verification and reproduction

From the development checkout, with Node 24 and its already installed Miniflare:

```powershell
node --test experiments/release-trust/verifier.test.mjs
node experiments/release-trust/local-workerd.mjs ./node_modules/miniflare
```

For a dedicated worktree without dependencies, pass the absolute installed
Miniflare package path or the adjacent development checkout's
`../LancerLogin/node_modules/miniflare`. The runner consumes the
existing Miniflare installation; no package, lockfile, runtime source or deploy
configuration changes are required. These isolated experiment commands are not
registered in the root verification scripts; run both after integration.

Observed on Node 24.14.1 / the development checkout's Miniflare 5.20260828.0-alpha
with compatibility date 2026-09-04:

- **13 Node tests passed**, including independent Node native crypto signing and
  verification against portable WebCrypto in both directions.
- **12 contract cases passed inside actual local workerd**, loading the same
  verifier ES module without Node compatibility. The cases cover exact-byte/domain
  tampering, wrong key/repository/channel, duplicate and escaped JSON keys,
  malformed/oversized input, prohibited fields/roles, invalid migration chains,
  forged handles, artifact size/hash changes, asynchronous input mutation,
  compatibility, downgrade rejection and checkpoint-bound code recovery.
- A fresh Node native Ed25519 signature was verified inside workerd; a fresh
  workerd signature was verified by both Node native crypto and Node WebCrypto.
- No Worker outbound requests occurred; the runner forbids them and disables
  Miniflare telemetry. Every key is generated ephemerally in memory for that run.
  No private key is written, printed or sent between runtimes. Fixtures use only
  synthetic repository identities, SQL and artifact bytes, and are not a release.

This is **local runtime interoperability**, not a Cloudflare development-deployment
test. No release, signing credential, cloud resource or production trust root was
created or changed.

## Remaining feasibility and P6 work

Choose and securely provision a development signing key and its publisher custody,
then a distinct production trust root through separately authorized bootstrap.
Key rotation/revocation and signed updater upgrades need their own pinned trust
procedure. Do not automatically accept an application's proposed replacement key.

Private assets need a dedicated read-only repository credential confined to the
approved development repository. Resolve release assets under the pinned numeric
repository and verify signed content; do not trust a moving branch, a user-provided
URL or a latest-release response alone. Handle provider redirects without forwarding
authorization to artifact hosts, enforce streaming download limits and verify the
immutable release association. GitHub immutable releases have since been enabled and read back on the authorized private development repository (see the P0 evidence record). Actual immutable publication, live private
asset access and build-to-source provenance are not established here.

The verifier trusts the publisher's source commit and compatibility declarations;
it does not independently reproduce a build or make malicious publisher code safe.
Signed bytes must still be assembled by a reviewed central build/release pipeline.
P6 must prove durable monotonic state under concurrency and restart, archive safety,
existing migration-ledger digest bootstrap, resource pin enforcement before provider
access, complete staging, binding/secret preservation, interrupted upgrades,
database restoration and independent recovery while the dashboard is broken.
