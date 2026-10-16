import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { acquireFingerprintStateLock } from "./fingerprint-state-lock.mjs";
import { fingerprintIdentityId, fingerprintPublicIdentity, generateFingerprintIdentity } from "./fingerprint-envelope.mjs";

const validId = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const failure = () => { throw new Error("Fingerprint sync identity requires local review"); };
const safeMode = (stat) => process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid());
const sameBinding = (left, right) => ["installationId", "kioskId", "pairingId"].every((key) => left?.[key] === right[key]);

// Recover only the binding from the protected local identity file. This grants
// no transfer authority; the full store validates keys/state again before use.
export async function readFingerprintBinding(path, { kioskId, pairingId }) {
  if (![kioskId, pairingId].every(validId)) return failure();
  let file, existed = false;
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || !safeMode(parent)) return failure();
    const entry = await lstat(path); existed = true;
    if (!entry.isFile() || entry.isSymbolicLink() || !safeMode(entry)) return failure();
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || !safeMode(stat) || stat.size > 65536 || stat.ino !== entry.ino || stat.dev !== entry.dev) return failure();
    const bytes = await file.readFile(); let state;
    try { state = JSON.parse(bytes.toString("utf8")); } finally { bytes.fill(0); }
    if (state?.version !== 1 || !validId(state.binding?.installationId) || state.binding.kioskId !== kioskId || state.binding.pairingId !== pairingId) return failure();
    return { installationId: state.binding.installationId, kioskId, pairingId };
  } catch (error) { if (!existed && error?.code === "ENOENT") return null; return failure(); }
  finally { await file?.close(); }
}

export function createFingerprintIdentityStore(path, binding) {
  if (![binding?.installationId, binding?.kioskId, binding?.pairingId].every(validId)) return failure();
  const bound = { installationId: binding.installationId, kioskId: binding.kioskId, pairingId: binding.pairingId };
  let operations = Promise.resolve();
  const exclusive = (operation) => {
    const result = operations.then(operation, operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };
  async function directory() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const stat = await lstat(dirname(path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || !safeMode(stat)) return failure();
  }
  function identity(state) {
    const encryptionPrivate = createPrivateKey(state.keys.encryption);
    const signingPrivate = createPrivateKey(state.keys.signing);
    const result = {
      encryption: { privateKey: encryptionPrivate, publicKey: createPublicKey(encryptionPrivate) },
      signing: { privateKey: signingPrivate, publicKey: createPublicKey(signingPrivate) },
    };
    fingerprintIdentityId(fingerprintPublicIdentity(result));
    return result;
  }
  function peer(value) {
    if (value?.installationId !== bound.installationId || !validId(value?.kioskId) || value.kioskId === bound.kioskId || !validId(value?.pairingId)) return failure();
    const publicIdentity = { encryption: value.publicIdentity?.encryption, signing: value.publicIdentity?.signing };
    const fingerprint = fingerprintIdentityId(publicIdentity);
    if (value.fingerprint !== fingerprint) return failure();
    return { installationId: bound.installationId, kioskId: value.kioskId, pairingId: value.pairingId, publicIdentity, fingerprint };
  }
  async function load() {
    let file;
    let existed = false;
    try {
      const entry = await lstat(path);
      existed = true;
      if (!entry.isFile() || entry.isSymbolicLink() || !safeMode(entry)) return failure();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || !safeMode(stat) || stat.size > 65536 || stat.ino !== entry.ino || stat.dev !== entry.dev) return failure();
      const raw = await file.readFile();
      let state;
      try { state = JSON.parse(raw.toString("utf8")); } finally { raw.fill(0); }
      if (state?.version !== 1 || !sameBinding(state.binding, bound) || typeof state.enabled !== "boolean" || !Array.isArray(state.peers) || state.peers.length > 32) return failure();
      identity(state);
      state.peers = state.peers.map(peer);
      if (new Set(state.peers.map((item) => item.kioskId)).size !== state.peers.length) return failure();
      return state;
    } catch (error) { if (!existed && error?.code === "ENOENT") return null; return failure(); }
    finally { await file?.close(); }
  }
  async function persist(state) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); file = undefined;
      await chmod(temporary, 0o600); await rename(temporary, path);
      if (process.platform !== "win32") {
        const folder = await open(dirname(path), constants.O_RDONLY);
        try { await folder.sync(); } finally { await folder.close(); }
      }
    } finally { await file?.close(); await unlink(temporary).catch(() => undefined); }
  }
  const publicStatus = (state) => {
    if (!state) return { enabled: false, binding: { ...bound }, publicIdentity: null, fingerprint: null, peers: [] };
    const publicIdentity = fingerprintPublicIdentity(identity(state));
    return { enabled: state.enabled, binding: { ...bound }, publicIdentity, fingerprint: fingerprintIdentityId(publicIdentity), peers: state.peers.map((item) => ({ ...item, publicIdentity: { ...item.publicIdentity } })) };
  };
  const mutate = (operation) => exclusive(async () => {
    await directory();
    const lockPath = `${path}.lock`;
    let lock;
    try {
      lock = await acquireFingerprintStateLock(lockPath);
      const state = await operation(await load());
      if (state) await persist(state);
      return publicStatus(state);
    } catch { return failure(); }
    finally { await lock?.close(); }
  });
  return {
    status: () => exclusive(async () => { await directory(); return publicStatus(await load()); }),
    setEnabled: (enabled) => mutate(async (state) => {
      if (typeof enabled !== "boolean") return failure();
      if (!state && !enabled) return null;
      if (!state) {
        const generated = await generateFingerprintIdentity();
        state = { version: 1, binding: { ...bound }, enabled: false, peers: [], keys: {
          encryption: generated.encryption.privateKey.export({ type: "pkcs8", format: "pem" }),
          signing: generated.signing.privateKey.export({ type: "pkcs8", format: "pem" }),
        } };
      }
      return { ...state, enabled };
    }),
    approvePeer: (candidate, confirmedFingerprint) => mutate(async (state) => {
      if (!state?.enabled) return failure();
      const approved = peer(candidate);
      if (confirmedFingerprint !== approved.fingerprint) return failure();
      const previous = state.peers.find((item) => item.kioskId === approved.kioskId);
      // Key/pairing replacement requires separate revocation and approval.
      if (previous && JSON.stringify(previous) !== JSON.stringify(approved)) return failure();
      if (!previous) { if (state.peers.length >= 32) return failure(); state.peers.push(approved); }
      return state;
    }),
    revokePeer: (kioskId) => mutate(async (state) => {
      if (!state || !validId(kioskId)) return failure();
      state.peers = state.peers.filter((item) => item.kioskId !== kioskId);
      return state;
    }),
    // Internal service capability only. Never expose via HTTP or return its keys
    // to a UI. Encryption operations must check peer/pairing authorization here.
    withApprovedPeer: (kioskId, pairingId, operation) => exclusive(async () => {
      await directory();
      const state = await load();
      const approved = state?.peers.find((item) => item.kioskId === kioskId && item.pairingId === pairingId);
      if (!state?.enabled || !approved) return failure();
      return operation({ identity: identity(state), peer: approved, binding: { ...bound } });
    }),
  };
}
