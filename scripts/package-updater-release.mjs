// Maintainer-only prebuilt packaging; no compiler, network, publication or deploy.
import { open, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { parseStrictJson, sha256 } from '../packages/shared/src/updater/application-release.mjs';
import { createUpdaterReleaseVerifier, updaterSignedBytes, UPDATER_LIMITS } from '../packages/shared/src/updater/updater-release.mjs';

const check = (condition, code) => { if (!condition) throw Error(code); };
const inside = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };
async function fileBytes(path, max) {
  const before = await lstat(path);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= max, 'updater-input-file');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.ino === before.ino && stat.dev === before.dev && stat.size === before.size, 'updater-input-changed');
    const data = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < data.length) { const result = await file.read(data, length, data.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    check(length === stat.size, 'updater-input-changed'); return data.subarray(0, length);
  } finally { await file.close(); }
}
export async function packageUpdaterRelease(options) {
  const names = ['metadata', 'updater', 'signingKey', 'out'];
  check(options && Object.keys(options).length === names.length && names.every(name => typeof options[name] === 'string' && options[name]), 'updater-arguments');
  const paths = Object.fromEntries(names.map(name => [name, resolve(options[name])]));
  const keyPath = await realpath(paths.signingKey);
  check(!inside(dirname(await realpath(paths.updater)), keyPath) && !inside(dirname(await realpath(paths.metadata)), keyPath) && !inside(paths.out, keyPath), 'updater-signing-key-overlap');
  const metadata = parseStrictJson(await fileBytes(paths.metadata, UPDATER_LIMITS.manifestBytes));
  check(!Object.hasOwn(metadata, 'artifact'), 'updater-derived-field');
  const artifactBytes = await fileBytes(paths.updater, UPDATER_LIMITS.artifactBytes);
  const artifact = { role: 'updater', name: 'updater.mjs', bytes: artifactBytes.length, sha256: await sha256(artifactBytes) };
  const manifestBytes = new TextEncoder().encode(JSON.stringify({ ...metadata, artifact }) + '\n');
  const keyBytes = await fileBytes(paths.signingKey, 16384);
  let signature, publicKey;
  try {
    check(keyBytes.toString('utf8').startsWith('-----BEGIN PRIVATE KEY-----'), 'updater-key-format');
    const key = createPrivateKey({ key: keyBytes, format: 'pem', type: 'pkcs8' });
    check(key.asymmetricKeyType === 'ed25519', 'updater-key-type');
    signature = new Uint8Array(sign(null, updaterSignedBytes(manifestBytes), key));
    publicKey = new Uint8Array(Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url'));
  } finally { keyBytes.fill(0); }
  const verifier = createUpdaterReleaseVerifier({ product: metadata.product, channel: metadata.channel, repository: metadata.repository, keyId: metadata.keyId, publicKey });
  const verified = await verifier.verify(manifestBytes, signature);
  await verifier.verifyArtifact(verified, artifactBytes);
  // Never overwrite/clean an existing directory. Manifest is the final marker;
  // failed output writes may leave an intentionally incomplete directory.
  await mkdir(paths.out);
  await writeFile(join(paths.out, 'updater.mjs'), artifactBytes, { flag: 'wx', mode: 0o644 });
  await writeFile(join(paths.out, 'manifest.sig'), signature, { flag: 'wx', mode: 0o644 });
  await writeFile(join(paths.out, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 });
  return Object.freeze({ manifestSha256: verified.manifestSha256, version: metadata.version, updaterSequence: metadata.sequence, stateSchema: metadata.targetStateSchema });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = { '--metadata': 'metadata', '--updater': 'updater', '--signing-key': 'signingKey', '--out': 'out' }, args = process.argv.slice(2), options = {};
    check(args.length === 8, 'updater-arguments');
    for (let i = 0; i < args.length; i += 2) { const name = flags[args[i]]; check(name && !Object.hasOwn(options, name), 'updater-arguments'); options[name] = args[i + 1]; }
    console.log(JSON.stringify(await packageUpdaterRelease(options)));
  } catch {
    console.error('Updater release packaging failed. Check prebuilt inputs, exact metadata, external Ed25519 PKCS8 key and a new output directory.');
    process.exitCode = 1;
  }
}
