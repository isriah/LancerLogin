// Maintainer-only local packaging. No build commands, network or deployment access.
import { open, lstat, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createApplicationVerifier, signedBytes, sha256, parseStrictJson, LIMITS } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard, readDashboard, validateDashboardPath, DASHBOARD_LIMITS } from '../packages/shared/src/updater/dashboard-archive.mjs';
const check = (ok, code) => { if (!ok) throw new Error(code); };
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };

async function boundedFile(path, max, allowEmpty = false) {
  const before = await lstat(path);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, 'input-regular-file');
  check(before.size <= max && (allowEmpty || before.size > 0), 'input-size');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.ino === before.ino && stat.dev === before.dev && stat.size === before.size, 'input-changed');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    check(length === stat.size, 'input-changed');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
async function directory(path) {
  const stat = await lstat(path); check(stat.isDirectory() && !stat.isSymbolicLink(), 'input-directory');
  return realpath(path);
}
async function dashboardFiles(root) {
  const entries = []; let total = 1024, visited = 0;
  async function walk(folder, prefix = '') {
    const names = await readdir(folder);
    for (const name of names.sort()) {
      check(++visited <= DASHBOARD_LIMITS.files * 2, 'dashboard-files');
      const path = prefix + name, absolute = join(folder, name), stat = await lstat(absolute);
      check(!stat.isSymbolicLink(), 'input-regular-file');
      if (stat.isDirectory()) {
        // Validate directory components using a permitted synthetic basename.
        validateDashboardPath(path + '/asset.js'); await walk(absolute, path + '/');
      } else {
        validateDashboardPath(path);
        const bytes = await boundedFile(absolute, DASHBOARD_LIMITS.fileBytes, true);
        total += 512 + Math.ceil(bytes.length / 512) * 512;
        check(total <= DASHBOARD_LIMITS.bytes && entries.length < DASHBOARD_LIMITS.files, 'dashboard-size');
        entries.push({ path, bytes });
      }
    }
  }
  await walk(root); return entries;
}

export async function packageApplicationRelease(options) {
  const names = ['metadata', 'api', 'dashboard', 'migrations', 'signingKey', 'out'];
  check(options && Object.keys(options).length === names.length && names.every(name => typeof options[name] === 'string' && options[name]), 'arguments');
  const paths = Object.fromEntries(names.map(name => [name, resolve(options[name])]));
  const dashboard = await directory(paths.dashboard), migrationsRoot = await directory(paths.migrations);
  const keyPath = await realpath(paths.signingKey);
  check(!inside(dashboard, keyPath) && !inside(migrationsRoot, keyPath), 'signing-key-input-overlap');
  check(keyPath !== await realpath(paths.api) && keyPath !== await realpath(paths.metadata), 'signing-key-input-overlap');
  check(!inside(dashboard, paths.out) && !inside(migrationsRoot, paths.out), 'output-input-overlap');
  const metadata = parseStrictJson(await boundedFile(paths.metadata, LIMITS.manifestBytes));
  check(!Object.hasOwn(metadata, 'artifacts') && !Object.hasOwn(metadata, 'migrations'), 'metadata-derived-fields');
  const files = new Map([['api.mjs', await boundedFile(paths.api, LIMITS.artifactBytes)], ['dashboard.tar', packDashboard(await dashboardFiles(dashboard))]]);
  const artifacts = [], migrations = [];
  const describe = async (role, name, bytes) => ({ role, name, bytes: bytes.length, sha256: await sha256(bytes) });
  artifacts.push(await describe('api', 'api.mjs', files.get('api.mjs')), await describe('dashboard', 'dashboard.tar', files.get('dashboard.tar')));
  const migrationNames = (await readdir(migrationsRoot)).sort();
  check(migrationNames.length <= 254, 'migration-chain');
  let total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  for (const [index, name] of migrationNames.entries()) {
    check(/^[0-9]{4}_[a-z0-9_-]{1,58}\.sql$/.test(name) && Number(name.slice(0, 4)) === index + 1, 'migration-chain');
    const bytes = await boundedFile(join(migrationsRoot, name), LIMITS.artifactBytes);
    total += bytes.length; check(total <= LIMITS.totalBytes, 'artifact-total'); files.set(name, bytes);
    const artifact = await describe('migration', name, bytes); artifacts.push(artifact);
    migrations.push({ id: name, fromSchema: index, toSchema: index + 1, artifact: name, sha256: artifact.sha256 });
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify({ ...metadata, artifacts, migrations }) + '\n');
  const keyBytes = await boundedFile(paths.signingKey, 16384);
  let signature, publicKey;
  try {
    check(keyBytes.toString('utf8').startsWith('-----BEGIN PRIVATE KEY-----'), 'signing-key-format');
    const key = createPrivateKey({ key: keyBytes, format: 'pem', type: 'pkcs8' });
    check(key.asymmetricKeyType === 'ed25519', 'signing-key-type');
    signature = new Uint8Array(sign(null, signedBytes(manifestBytes), key));
    publicKey = new Uint8Array(Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url'));
  } finally { keyBytes.fill(0); }
  const verifier = createApplicationVerifier({ product: metadata.product, channel: metadata.channel, repository: metadata.repository, keyId: metadata.keyId, publicKey });
  const verified = await verifier.verify(manifestBytes, signature);
  for (const [name, bytes] of files) await verifier.verifyArtifact(verified, name, bytes);
  readDashboard(files.get('dashboard.tar'));
  // New directory only. A partial failed write has no valid manifest commit marker.
  // Never replace/re-sign an existing release directory or clean it automatically.
  await mkdir(paths.out);
  for (const [name, bytes] of files) await writeFile(join(paths.out, name), bytes, { flag: 'wx', mode: 0o644 });
  await writeFile(join(paths.out, 'manifest.sig'), signature, { flag: 'wx', mode: 0o644 });
  await writeFile(join(paths.out, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 });
  return Object.freeze({ manifestSha256: verified.manifestSha256, artifacts: artifacts.length, version: metadata.version, sequence: metadata.sequence });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = { '--metadata': 'metadata', '--api': 'api', '--dashboard': 'dashboard', '--migrations': 'migrations', '--signing-key': 'signingKey', '--out': 'out' };
    const args = process.argv.slice(2), options = {};
    check(args.length === 12, 'arguments');
    for (let i = 0; i < args.length; i += 2) { const name = flags[args[i]]; check(name && !Object.hasOwn(options, name), 'arguments'); options[name] = args[i + 1]; }
    console.log(JSON.stringify(await packageApplicationRelease(options)));
  } catch {
    // Native key/filesystem errors can contain private input. Never echo them.
    console.error('Application release packaging failed. Check explicit inputs, metadata, Ed25519 PKCS8 key and a new output directory.');
    process.exitCode = 1;
  }
}
