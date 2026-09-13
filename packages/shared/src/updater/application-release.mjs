// Shared updater trust boundary: no provider, filesystem, mutation, or signing key.
export const DOMAIN = 'LancerLogin release manifest v1\n';
export const LIMITS = Object.freeze({ manifestBytes: 131072, artifacts: 256, artifactBytes: 16777216, totalBytes: 67108864, depth: 12 });
const utf8 = new TextEncoder();
const fail = code => { throw new Error(code); };
const check = (condition, code) => { if (!condition) fail(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => check(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'schema');
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => check(Number.isSafeInteger(value) && value >= min && value <= max, 'integer');
const pattern = (value, regex) => {
  // JavaScript's `$` also matches before a final newline; require a full match.
  const match = typeof value === 'string' ? regex.exec(value) : null;
  check(match !== null && match[0].length === value.length, 'schema');
};
const digest = value => pattern(value, /^[a-f0-9]{64}$/);
const name = value => pattern(value, /^[a-z0-9][a-z0-9_-]{0,63}\.(?:mjs|tar|sql)$/);
const version = value => { pattern(value, /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/); return value.split('.').map(Number); };
const compare = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]); return 0; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const copyBytes = (value, max, min = 1) => {
  check(value instanceof Uint8Array && value.byteLength >= min && value.byteLength <= max, 'size');
  // Snapshot before any await: caller mutation cannot change the signed/hashed bytes.
  return Uint8Array.from(value);
};
export const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const sha256 = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
export function signedBytes(bytes) {
  const body = copyBytes(bytes, LIMITS.manifestBytes), prefix = utf8.encode(DOMAIN);
  const result = new Uint8Array(prefix.length + body.length); result.set(prefix); result.set(body, prefix.length); return result;
}

// JSON.parse alone loses duplicate keys. This bounded parser decodes keys before
// comparing them, including escaped spellings, at every object nesting level.
export function parseStrictJson(bytes) {
  const data = copyBytes(bytes, LIMITS.manifestBytes);
  check(!(data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf), 'utf8');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { fail('utf8'); }
  let at = 0, count = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(source[at] ?? '\0')) at++; };
  const string = () => {
    check(source[at] === '"', 'json'); const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') { try { return JSON.parse(source.slice(start, at)); } catch { fail('json'); } }
    }
    fail('json');
  };
  const value = depth => {
    check(depth <= LIMITS.depth && ++count <= 20000, 'complexity'); ws();
    if (source[at] === '"') return string();
    if (source[at] === '{') {
      at++; ws(); const result = Object.create(null), seen = new Set();
      if (source[at] === '}') { at++; return result; }
      while (true) {
        ws(); const key = string(); check(!seen.has(key), 'duplicate-key'); seen.add(key);
        ws(); check(source[at++] === ':', 'json'); result[key] = value(depth + 1); ws();
        const next = source[at++]; if (next === '}') return result; check(next === ',', 'json');
      }
    }
    if (source[at] === '[') {
      at++; ws(); const result = [];
      if (source[at] === ']') { at++; return result; }
      while (true) { result.push(value(depth + 1)); ws(); const next = source[at++]; if (next === ']') return result; check(next === ',', 'json'); }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    check(literal, 'json'); at += literal[0].length; return JSON.parse(literal[0]);
  };
  const result = value(0); ws(); check(at === source.length, 'json'); return result;
}

function repository(value) {
  exact(value, ['id', 'owner', 'name']); integer(value.id, 1);
  pattern(value.owner, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/); pattern(value.name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
}
function range(value, versions = false) {
  exact(value, ['min', 'max']);
  if (versions) { check(compare(value.min, value.max) <= 0, 'range'); }
  else { integer(value.min); integer(value.max); check(value.min <= value.max, 'range'); }
}
function schema(m) {
  exact(m, ['format', 'kind', 'product', 'channel', 'keyId', 'repository', 'sequence', 'version', 'sourceCommit', 'minimumUpdaterVersion', 'compatibility', 'targetSchema', 'codeRollback', 'artifacts', 'migrations']);
  check(m.format === 1 && m.kind === 'application' && m.product === 'LancerLogin', 'schema');
  pattern(m.channel, /^[a-z][a-z0-9-]{0,31}$/); pattern(m.keyId, /^[a-z][a-z0-9-]{0,63}$/); repository(m.repository);
  integer(m.sequence, 1); version(m.version); version(m.minimumUpdaterVersion); pattern(m.sourceCommit, /^[a-f0-9]{40}$/); integer(m.targetSchema, 0, 254);
  check(['compatible', 'restore-required'].includes(m.codeRollback), 'schema');
  const c = m.compatibility;
  exact(c, ['installedVersion', 'installedSchema', 'apiVersion', 'apiSchema', 'frontendApi']);
  range(c.installedVersion, true); range(c.installedSchema); integer(c.apiVersion, 1); range(c.apiSchema); range(c.frontendApi);
  check(c.installedSchema.max <= m.targetSchema && c.apiSchema.min <= m.targetSchema && c.apiSchema.max >= m.targetSchema && c.frontendApi.min <= c.apiVersion && c.frontendApi.max >= c.apiVersion, 'compatibility');
  check(Array.isArray(m.artifacts) && m.artifacts.length >= 2 && m.artifacts.length <= LIMITS.artifacts, 'artifacts');
  const names = new Map(); const roles = { api: 0, dashboard: 0, migration: 0 }; let total = 0;
  for (const artifact of m.artifacts) {
    exact(artifact, ['role', 'name', 'bytes', 'sha256']); name(artifact.name); digest(artifact.sha256); integer(artifact.bytes, 1, LIMITS.artifactBytes);
    check(typeof artifact.role === 'string' && Object.hasOwn(roles, artifact.role), 'artifact-role'); check(!names.has(artifact.name), 'duplicate-artifact');
    check(artifact.name.endsWith({ api: '.mjs', dashboard: '.tar', migration: '.sql' }[artifact.role]), 'artifact-role');
    names.set(artifact.name, artifact); roles[artifact.role]++; total += artifact.bytes;
  }
  check(roles.api === 1 && roles.dashboard === 1 && total <= LIMITS.totalBytes, 'artifacts');
  // Full schema chain makes historic digests checkable, not just new SQL files.
  check(Array.isArray(m.migrations) && m.migrations.length === m.targetSchema && roles.migration === m.migrations.length, 'migration-chain');
  const ids = new Set(), files = new Set();
  for (let i = 0; i < m.migrations.length; i++) {
    const migration = m.migrations[i];
    exact(migration, ['id', 'fromSchema', 'toSchema', 'artifact', 'sha256']);
    pattern(migration.id, /^[0-9]{4}_[a-z0-9_-]{1,58}\.sql$/); digest(migration.sha256);
    check(!ids.has(migration.id) && !files.has(migration.artifact), 'duplicate-migration'); ids.add(migration.id); files.add(migration.artifact);
    check(migration.fromSchema === i && migration.toSchema === i + 1 && Number(migration.id.slice(0, 4)) === i + 1, 'migration-chain');
    const artifact = names.get(migration.artifact);
    check(artifact?.role === 'migration' && artifact.name === migration.id && artifact.sha256 === migration.sha256, 'migration-artifact');
  }
}

function stateSchema(state) {
  exact(state, ['version', 'schema', 'updaterVersion', 'highestSequence', 'ledger']);
  version(state.version); version(state.updaterVersion); integer(state.schema, 0, 254); integer(state.highestSequence);
  check(Array.isArray(state.ledger) && state.ledger.length === state.schema, 'installed-ledger');
  state.ledger.forEach((entry, i) => {
    exact(entry, ['id', 'sha256']); pattern(entry.id, /^[0-9]{4}_[a-z0-9_-]{1,58}\.sql$/); digest(entry.sha256);
    check(Number(entry.id.slice(0, 4)) === i + 1, 'installed-ledger');
  });
}

export function createApplicationVerifier(pins) {
  exact(pins, ['product', 'channel', 'repository', 'keyId', 'publicKey']);
  check(pins.product === 'LancerLogin', 'pins'); repository(pins.repository);
  pattern(pins.channel, /^[a-z][a-z0-9-]{0,31}$/); pattern(pins.keyId, /^[a-z][a-z0-9-]{0,63}$/);
  const keyBytes = copyBytes(pins.publicKey, 32, 32);
  const trust = freeze({ product: pins.product, channel: pins.channel, repository: { ...pins.repository }, keyId: pins.keyId });
  const handles = new WeakSet();
  const own = verified => check(object(verified) && handles.has(verified), 'unverified-manifest');
  const current = (verified, state) => {
    own(verified); stateSchema(state);
    check(compare(state.updaterVersion, verified.manifest.minimumUpdaterVersion) >= 0, 'updater-version');
    const chain = verified.manifest.migrations;
    for (let i = 0; i < Math.min(chain.length, state.ledger.length); i++) check(chain[i].id === state.ledger[i].id && chain[i].sha256 === state.ledger[i].sha256, 'installed-ledger');
  };
  return Object.freeze({
    async verify(manifestBytes, signatureBytes) {
      const bytes = copyBytes(manifestBytes, LIMITS.manifestBytes), signature = copyBytes(signatureBytes, 64, 64);
      const manifest = parseStrictJson(bytes); schema(manifest);
      check(manifest.product === trust.product && manifest.channel === trust.channel && manifest.keyId === trust.keyId, 'trust');
      check(['id', 'owner', 'name'].every(key => manifest.repository[key] === trust.repository[key]), 'source');
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
      check(await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, signedBytes(bytes)), 'signature');
      const verified = freeze({ manifest, manifestSha256: await sha256(bytes) }); handles.add(verified); return verified;
    },
    async verifyArtifact(verified, artifactName, artifactBytes) {
      own(verified); const artifact = verified.manifest.artifacts.find(item => item.name === artifactName); check(artifact, 'unknown-artifact');
      const bytes = copyBytes(artifactBytes, LIMITS.artifactBytes);
      check(bytes.length === artifact.bytes, 'artifact-length'); check(await sha256(bytes) === artifact.sha256, 'artifact-digest');
      return bytes;
    },
    evaluateUpdate(verified, state) {
      current(verified, state); const m = verified.manifest, c = m.compatibility;
      check(m.sequence > state.highestSequence && compare(m.version, state.version) > 0, 'downgrade');
      check(compare(state.version, c.installedVersion.min) >= 0 && compare(state.version, c.installedVersion.max) <= 0 && state.schema >= c.installedSchema.min && state.schema <= c.installedSchema.max, 'installed-compatibility');
      return freeze({ mode: 'update', manifestSha256: verified.manifestSha256, nextHighestSequence: m.sequence, migrations: m.migrations.slice(state.schema), codeRollback: m.codeRollback });
    },
    evaluateCodeRecovery(verified, state, checkpoint) {
      current(verified, state);
      exact(checkpoint, ['manifestSha256', 'sequence', 'version', 'schema', 'codeRollback']);
      digest(checkpoint.manifestSha256); integer(checkpoint.sequence, 1); version(checkpoint.version); integer(checkpoint.schema, 0, 254);
      const m = verified.manifest;
      check(checkpoint.manifestSha256 === verified.manifestSha256 && checkpoint.sequence === m.sequence && checkpoint.version === m.version && checkpoint.schema === m.targetSchema && checkpoint.sequence <= state.highestSequence, 'recovery-checkpoint');
      // This classification belongs to the interrupted upgrade's trusted checkpoint,
      // not the older release being restored. The older API must handle current DB.
      check(checkpoint.codeRollback === 'compatible' && state.schema >= m.targetSchema && state.schema >= m.compatibility.apiSchema.min && state.schema <= m.compatibility.apiSchema.max, 'restore-required');
      return freeze({ mode: 'code-recovery', manifestSha256: verified.manifestSha256, nextHighestSequence: state.highestSequence, migrations: [] });
    },
  });
}
