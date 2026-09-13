import { parseStrictJson, sha256 } from './application-release.mjs';

export const UPDATER_DOMAIN = 'LancerLogin updater release manifest v1\n';
export const UPDATER_LIMITS = Object.freeze({ manifestBytes: 16384, artifactBytes: 16777216 });
const check = (value, code) => { if (!value) throw Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => check(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'updater-schema');
const pattern = (value, expression) => { const match = typeof value === 'string' ? expression.exec(value) : null; check(match && match[0] === value, 'updater-schema'); };
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => check(Number.isSafeInteger(value) && value >= min && value <= max, 'updater-integer');
const version = value => { pattern(value, /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/); return value.split('.').map(Number); };
const compare = (left, right) => { const a = version(left), b = version(right); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]); return 0; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const bytes = (value, max, min = 1) => { check(value instanceof Uint8Array && value.length >= min && value.length <= max, 'updater-size'); return Uint8Array.from(value); };
function repository(value) {
  exact(value, ['id', 'owner', 'name']); integer(value.id, 1);
  pattern(value.owner, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/); pattern(value.name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
}
function range(value, versions = false) {
  exact(value, ['min', 'max']);
  if (versions) check(compare(value.min, value.max) <= 0, 'updater-range');
  else { integer(value.min, 0, 254); integer(value.max, 0, 254); check(value.min <= value.max, 'updater-range'); }
}
function schema(manifest) {
  exact(manifest, ['format', 'kind', 'product', 'channel', 'keyId', 'repository', 'sequence', 'version', 'sourceCommit', 'compatibility', 'targetStateSchema', 'artifact']);
  check(manifest.format === 1 && manifest.kind === 'updater' && manifest.product === 'LancerLogin', 'updater-kind');
  pattern(manifest.channel, /^[a-z][a-z0-9-]{0,31}$/); pattern(manifest.keyId, /^[a-z][a-z0-9-]{0,63}$/); repository(manifest.repository);
  integer(manifest.sequence, 1); version(manifest.version); pattern(manifest.sourceCommit, /^[a-f0-9]{40}$/); integer(manifest.targetStateSchema, 0, 254);
  exact(manifest.compatibility, ['updaterVersion', 'stateSchema']); range(manifest.compatibility.updaterVersion, true); range(manifest.compatibility.stateSchema);
  check(manifest.targetStateSchema >= manifest.compatibility.stateSchema.min && manifest.targetStateSchema <= manifest.compatibility.stateSchema.max, 'updater-state-compatibility');
  exact(manifest.artifact, ['role', 'name', 'bytes', 'sha256']);
  check(manifest.artifact.role === 'updater' && manifest.artifact.name === 'updater.mjs', 'updater-artifact');
  integer(manifest.artifact.bytes, 1, UPDATER_LIMITS.artifactBytes); pattern(manifest.artifact.sha256, /^[a-f0-9]{64}$/);
}
export function updaterSignedBytes(input) {
  const body = bytes(input, UPDATER_LIMITS.manifestBytes), prefix = new TextEncoder().encode(UPDATER_DOMAIN);
  const output = new Uint8Array(prefix.length + body.length); output.set(prefix); output.set(body, prefix.length); return output;
}

/** Pure trust helper: no resource access, mutation, private key or self-deploy. */
export function createUpdaterReleaseVerifier(pins) {
  exact(pins, ['product', 'channel', 'repository', 'keyId', 'publicKey']);
  check(pins.product === 'LancerLogin', 'updater-pins'); repository(pins.repository);
  pattern(pins.channel, /^[a-z][a-z0-9-]{0,31}$/); pattern(pins.keyId, /^[a-z][a-z0-9-]{0,63}$/);
  const publicKey = bytes(pins.publicKey, 32, 32), trust = freeze({ product: pins.product, channel: pins.channel, repository: { ...pins.repository }, keyId: pins.keyId });
  const handles = new WeakSet();
  const own = handle => check(object(handle) && handles.has(handle), 'unverified-updater-manifest');
  return Object.freeze({
    async verify(input, detachedSignature) {
      const data = bytes(input, UPDATER_LIMITS.manifestBytes), signature = bytes(detachedSignature, 64, 64);
      const manifest = parseStrictJson(data); schema(manifest);
      check(manifest.product === trust.product && manifest.channel === trust.channel && manifest.keyId === trust.keyId, 'updater-trust');
      check(['id', 'owner', 'name'].every(key => manifest.repository[key] === trust.repository[key]), 'updater-source');
      const key = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
      check(await crypto.subtle.verify('Ed25519', key, signature, updaterSignedBytes(data)), 'updater-signature');
      const verified = freeze({ manifest, manifestSha256: await sha256(data) }); handles.add(verified); return verified;
    },
    async verifyArtifact(verified, input) {
      own(verified); const data = bytes(input, UPDATER_LIMITS.artifactBytes), artifact = verified.manifest.artifact;
      check(data.length === artifact.bytes && await sha256(data) === artifact.sha256, 'updater-artifact-integrity');
      return data;
    },
    evaluateUpdate(verified, installed) {
      own(verified);
      // Deliberately distinct from the application highestSequence/version state.
      exact(installed, ['updaterVersion', 'stateSchema', 'highestUpdaterSequence']);
      version(installed.updaterVersion); integer(installed.stateSchema, 0, 254); integer(installed.highestUpdaterSequence);
      const manifest = verified.manifest, compatibility = manifest.compatibility;
      check(manifest.sequence > installed.highestUpdaterSequence && compare(manifest.version, installed.updaterVersion) > 0, 'updater-downgrade');
      check(compare(installed.updaterVersion, compatibility.updaterVersion.min) >= 0 && compare(installed.updaterVersion, compatibility.updaterVersion.max) <= 0 && installed.stateSchema >= compatibility.stateSchema.min && installed.stateSchema <= compatibility.stateSchema.max, 'updater-installed-compatibility');
      check(manifest.targetStateSchema === installed.stateSchema, 'updater-state-migration-required');
      return freeze({ mode: 'updater-update', manifestSha256: verified.manifestSha256, version: manifest.version, stateSchema: installed.stateSchema, nextHighestUpdaterSequence: manifest.sequence });
    },
  });
}
