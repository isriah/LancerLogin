# Signed application release bundles

WU-168 supplies local maintainer packaging and portable updater verification. It
does not publish a release, deploy an updater, provision signing trust or grant
deployment authority. Dependencies: reviewed central build outputs, publisher key
custody and separately pinned installation trust; immutable release publication,
authenticated asset retrieval and durable updater orchestration follow separately.

`packages/shared/src/updater/application-release.mjs` is the production location
of the existing v1 verifier. The experiment re-exports it so there is one trust
implementation. The exact schema, signature domain, compatibility checks,
anti-rollback high-water mark and checkpoint-bound recovery are unchanged from
[the release trust contract](RELEASE-TRUST-FEASIBILITY.md). Shared package exports
are `@lancerlogin/shared/updater/application-release` and
`@lancerlogin/shared/updater/dashboard-archive`.

## Local maintainer command

Use Node 24 with an already reviewed, centrally built API entrypoint, Pages output
directory and the **complete** ordered SQL migration directory. The command does
not build, read environment credentials, run input commands or contact a provider.
Supply an explicit Ed25519 unencrypted PKCS8 PEM private-key file kept outside
both input directories and separate from API/metadata. Provisioning and handling
real signing keys require their own approved custody procedure. Tests generate
only ephemeral synthetic keys; no private key belongs in a checkout or release.

```powershell
node scripts/package-application-release.mjs --metadata release-metadata.json --api build/api/index.js --dashboard build/pages --migrations apps/api/migrations --signing-key C:/private/release-signing.pem --out build/signed-release
```

All six arguments are required. The output directory must not exist. The CLI
prints only manifest SHA-256, version, sequence and artifact count, or a fixed
failure message. It never prints native key errors or input file contents. It
produces `manifest.json`, raw 64-byte `manifest.sig`, `api.mjs`, `dashboard.tar`,
and each signed SQL basename. Every artifact is verified against the new signed
manifest before writing; the manifest is written last. A partial failed directory
must not be published or reused. Existing outputs are never overwritten. Files
are ordinary local files: cryptographic verification detects changes; provider
immutable publication is a separate required step, not a filesystem property.

Metadata contains every required v1 manifest field except `artifacts` and
`migrations`, which the packager derives. Unknown fields are rejected. For example,
this **synthetic** schema-one upgrade describes a single `0001_initial.sql` input:

```json
{
  "format": 1,
  "kind": "application",
  "product": "LancerLogin",
  "channel": "development",
  "keyId": "synthetic-test",
  "repository": { "id": 123, "owner": "synthetic", "name": "release-test" },
  "sequence": 2,
  "version": "1.1.0",
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "minimumUpdaterVersion": "1.0.0",
  "compatibility": {
    "installedVersion": { "min": "1.0.0", "max": "1.0.0" },
    "installedSchema": { "min": 0, "max": 0 },
    "apiVersion": 1,
    "apiSchema": { "min": 0, "max": 1 },
    "frontendApi": { "min": 1, "max": 1 }
  },
  "targetSchema": 1,
  "codeRollback": "compatible"
}
```

The publisher is responsible for accurate source and compatibility declarations.
Signing proves publisher approval of exact bytes; it does not reproduce a build,
review SQL, validate embedded application behavior, establish mixed-version safe
deployment order or provision the consumer's pinned key. A self-verified package
with a different key will still fail at the independently pinned updater.

## Dashboard artifact boundary

The portable codec writes deterministic uncompressed ustar with sorted ASCII
paths, fixed mode `0644`, zero timestamps/ownership and exactly two zero trailer
blocks. It accepts at most 2,048 regular files, 8 MiB per file, 16 MiB for the
archive and 100 ASCII bytes per path. `index.html` is required; `_worker.js`,
`_headers`, `_redirects`, static assets and source maps are supported. Filesystem
packaging rejects symlinks, hardlinks, special files, hidden components, likely
credential filenames and non-static extensions rather than silently excluding
them. Package a reviewed build directory, never a repository or secrets folder.
These restrictions prevent accidental hidden-key inclusion, but cannot detect a
credential embedded in otherwise valid JavaScript, JSON or a source map.

`readDashboard(bytes)` accepts only that canonical subset: no traversal, absolute
paths, drive paths, backslashes, case-insensitive duplicates, file/directory
conflicts, link entries, directory entries, PAX/GNU extensions, nonzero padding or
extra trailer data. It returns a frozen array of `{ path, bytes }` with private
byte copies; it never extracts to disk or interprets code. The caller owns and
must preserve those bytes before provider upload.

An updater first bounds artifact downloads while streaming, then calls
`verifier.verifyArtifact(verified, 'dashboard.tar', bytes)`, then
`readDashboard(verifiedBytes)`. A structurally valid archive alone proves no
signature or artifact identity. Persisted staged bytes must be reverified after
restart. Download/provider credentials, installation resource pins, update locks,
database backups/migrations, health checks and recovery stay in the independent
updater, not in these artifacts.

## Focused verification

```powershell
node --test tests/application-release.test.mjs
node experiments/release-trust/local-workerd.mjs ./node_modules/miniflare
```

The first command includes the existing 13 trust/security cases and two packaging
and archive cases. The latter reuses the original 12-case real local workerd
interoperability runner with the production verifier. Neither uses a live key,
publishes anything or proves hosted update/recovery behavior.
