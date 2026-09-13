# Signed updater release bundles

WU-175 adds the separately typed updater release verifier and maintainer packager.
It does **not** deploy or replace the updater. Dependencies: the established
[application release trust boundary](APPLICATION-RELEASE-BUNDLES.md), independent
updater state, and a future authorized updater-upgrade/recovery transport.

## Separate trust domain and installed state

`packages/shared/src/updater/updater-release.mjs` signs/verifies the UTF-8 prefix
`LancerLogin updater release manifest v1` followed by one LF and the **original
manifest bytes**. It uses raw 64-byte Ed25519 signatures and the pinned 32-byte raw
public key. This differs from the application release domain and exact schema.
Application/updater signatures and opaque verified handles are not interchangeable,
even when the signer key is the same. Production and development retain distinct
bootstrap source/channel/key pins; this module cannot rotate or replace them.

The verifier snapshots inputs before asynchronous work and deeply freezes verified
handles. It reuses the strict JSON parser and SHA-256 primitive; duplicate decoded
keys, malformed UTF-8, BOMs, extra fields and invalid schemas remain rejected.
Manifests are limited to 16 KiB and the one Worker artifact to 16 MiB. These are
format limits, not demonstrated hosted upload/CPU capacity.

The exact signed fields are:

| Field | Meaning |
| --- | --- |
| `format`, `kind`, `product` | Exactly `1`, `updater`, `LancerLogin`. |
| `channel`, `keyId`, `repository` | Bootstrap pins; repository is exact numeric `id`, `owner`, `name`. |
| `sequence`, `version`, `sourceCommit` | Positive monotonic updater sequence, numeric semantic version and 40-character source commit. |
| `compatibility.updaterVersion` | Inclusive `min`/`max` installed updater-version range. |
| `compatibility.stateSchema` | Inclusive `min`/`max` independently owned updater-state schema range. |
| `targetStateSchema` | State schema expected after replacement. |
| `artifact` | Exactly `{role:'updater',name:'updater.mjs',bytes,sha256}`. |

There are no resource, binding, environment, credential, command, URL, migration or
trust-replacement fields. The future deployment transport must retain infrastructure
and trust pins; a valid signature is not itself mutation authorization. As with any
executable release, the signing publisher remains trusted for what its code does.
Schema restrictions cannot make a malicious authorized publisher's code safe.

`createUpdaterReleaseVerifier(pins)` exposes `verify`, `verifyArtifact` and
`evaluateUpdate`. Evaluation accepts **updater-owned**
`{updaterVersion,stateSchema,highestUpdaterSequence}`. Its high-water mark is separate
from the application's `highestSequence`; application state cannot be passed in
place of updater state. Both version and sequence must increase, and installed
version/state must be compatible.

Until a real updater-state migration protocol exists, `targetStateSchema` must
equal the current `stateSchema`, even if the signed compatibility range includes
both. Evaluation reports `updater-state-migration-required` otherwise. It does not
pretend to execute migrations, acquire a lock, persist a sequence, preserve secrets,
replace itself or prove recovery. The independent highest-updater-sequence field
must be bootstrapped/persisted by the eventual upgrade runtime before deployment.

## Maintainer packaging

`scripts/package-updater-release.mjs` accepts prebuilt Worker bytes and metadata
containing the signed fields above **except `artifact`**, which it derives. It runs
no build commands and performs no network, release publication or deployment.

```powershell
node scripts/package-updater-release.mjs --metadata inputs/updater-metadata.json --updater inputs/worker.mjs --signing-key ../protected/updater-signing.pem --out output/updater-release
```

The signing key must be an Ed25519 PKCS8 PEM file outside both input directories
and the output directory. Regular bounded files are required; symlinks and hardlinks
are rejected. The packager reads only the explicit metadata, Worker and key files,
clears the temporary key-byte buffer, signs exact serialized manifest bytes and
self-verifies both signature and artifact. It emits only `updater.mjs`,
`manifest.sig` and `manifest.json`. Identical inputs/key produce identical bytes.
The supplied metadata's field order is retained; this is not a general JSON
canonicalization or source-reproducibility claim.

Output must be a new directory. Writes are exclusive, with `manifest.json` written
last as the completion marker. An interrupted output may remain incomplete; the
CLI never overwrites or automatically removes it. CLI errors are generic so native
filesystem/key parser errors cannot print key paths/content. Signing-key custody,
reviewed builds and private publication remain separately authorized work.

## Evidence and remaining work

Run `node --test tests/updater-release.test.mjs`. Four focused tests use ephemeral
keys and synthetic artifacts. They cover domain/type/handle separation with a shared
signer, wrong source/channel, forbidden resource/secret/command fields, duplicate
keys, byte tampering, independent antirollback state, incompatible state schema and
the actual CLI roundtrip/determinism/overwrite/key-overlap behavior. No real key,
resource, dependency or application verifier was changed.

## Standalone upgrade executor (WU190 local implementation)

`apps/updater/src/self-upgrade.mjs` supplies an intentionally unwired executor.
`updater-code.mjs` verifies updater-domain bytes, inspects the exact pinned Worker,
preserves fixed configuration/nonsecret bindings and the complete secret-name/type
inventory, and performs explicit deployment/readback using a supplied Fetch transport.
The updater's target state schema must remain unchanged. No updater-state migration,
runtime route, release discovery or interface is installed by this unit.

Trusted construction supplies capability, verifier pins, independent encrypted store,
primary updater database, code transport and `withUpdaterQuiescence(callback)`.
The callback supplies `assertHeld()`: an **external** exclusive authority proving
old updater requests/egress finished and new updater executions/application-update
admissions remain excluded for the entire callback. Reassertion is required before
every mutation. This code does not implement that fence. A timeout, expired lease,
Worker replacement or new recovery session cannot satisfy it. There is no force-clear.
The executor additionally reads primary application-job, maintenance, orchestration,
held-job and execution-permit/operation state in one query. It requires no app job or
a succeeded/recovered job without a pending operation, open maintenance/orchestration,
and no active holds/permits or pending operations. An injected affirmative fence alone
cannot override these database checks.

Initialization verifies the trusted prior signed artifact and actual provider code,
version and configuration. Its retry identity is retained. Installed updater metadata,
`highestUpdaterSequence`, active job and prior checkpoint live in one namespaced
encrypted CAS control row using the existing artifact-operation table; no0008 is
required. Admission reserves the new sequence and exclusive job in that same CAS.
Artifact storage is separate and immutable, keyed by verified manifest digest. Each
`writeChunk` action writes at most98,304bytes; a16MiB artifact needs171 actions. Whole
verification/sealing uses existing16-chunk paged reads, not171 separate chunk queries
inside one advance. Focused SQLite checks bound a chunk action below16 executed SQL
statements and seal/prepare below40; these are local statement counts, not hosted
latency or D1 row-quota measurements.

Advancement verifies retained bytes and exact prior provider identity, durably records
dispatch, then sends at most one deployment. Every later advance for that operation
uses marker/version/deployment/configuration/code readback only. Zero/multiple matches
or a lost response cannot cause redispatch. Even fence loss after the dispatch record
but before the network request leaves an unresolved operation; it cannot be force-cleared.
Successful provider readback reports `deployed`; explicit supervisor `accept` records
acceptance but does not assert application-level health. Installing broken signed code
can therefore still require independent recovery before acceptance.

`apps/updater/self-recovery.mjs` is independently constructible from retained trusted
supervisor code **outside the Worker being replaced**. It can reconcile an existing
dispatch and explicitly restore only that job's retained prior signed artifact and
configuration after exact candidate-deployment readback. It cannot initiate a prepared
upgrade. Recovery has its own durable dispatch identity and the same readback rule;
the installed version may return to the prior version, while highestUpdaterSequence
never decreases. Neither executor restores the application database or updater state.

Required later dependencies are the real external execution fence, an independently
available recovery execution location and its credentials/key custody, trusted installed
state bootstrap, application-engine updater-version synchronization, release-source
wiring, and hosted deployment/health/recovery acceptance. The current runtime creates
its recovery service alongside the replaceable updater and does not provide these
guarantees. This unit must remain unwired until those dependencies are supplied.

Run `node --test tests/updater-self-upgrade.test.mjs tests/updater-release.test.mjs`.
Seven focused checks passed using actual SQLite, ephemeral keys and Fetch fixtures:
domain/source/schema rejection, concurrent CAS admission, absent fence/current app
activity, drift,16MiB bounded staging, lost upgrade/recovery acknowledgments and a
separately constructed executor recovering a deliberately broken signed replacement.
No actual network, credential provisioning, deployment or resource change occurred.
