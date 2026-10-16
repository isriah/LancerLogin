import { fingerprintDiagnosticError, fingerprintDiagnosticOperation } from "./fingerprint-diagnostics.mjs";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFingerprintStateLock } from "./fingerprint-state-lock.mjs";
import { fingerprintEnvelopeDigest, fingerprintIdentityId } from "./fingerprint-envelope.mjs";

const fail = () => { throw fingerprintDiagnosticError("local_state_review"); };
const id = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const safeMode = stat => process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid());
const terminal = ["complete", "needs_review", "rejected", "expired", "revoked"];

// Ciphertext only. Dispatchers must additionally hold current approved-peer
// authority and check active membership before sending each pending envelope.
export function createFingerprintOutbox(path, binding, { publicIdentity, now = Date.now }) {
  if (![binding?.installationId, binding?.kioskId, binding?.pairingId].every(id)) return fail();
  const bound = { installationId: binding.installationId, kioskId: binding.kioskId, pairingId: binding.pairingId, keyId: fingerprintIdentityId(publicIdentity) };
  let tail = Promise.resolve();
  const exclusive = operation => {
    const result = tail.then(operation, operation); tail = result.then(() => undefined, () => undefined); return result;
  };
  function verify(envelope, instant) {
    const c = envelope?.context;
    const expected = { ...c, installationId: bound.installationId, senderId: bound.kioskId, senderPairingId: bound.pairingId, senderKeyId: bound.keyId };
    return fingerprintEnvelopeDigest(envelope, { sender: publicIdentity, expected, now: instant });
  }
  async function directory() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const stat = await lstat(dirname(path));
    if (!stat.isDirectory() || stat.isSymbolicLink() || !safeMode(stat)) return fail();
  }
  async function load() {
    let file, existed = false;
    try {
      const entry = await lstat(path); existed = true;
      if (!entry.isFile() || entry.isSymbolicLink() || !safeMode(entry)) return fail();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || !safeMode(stat) || stat.size > 1048576 || stat.ino !== entry.ino || stat.dev !== entry.dev) return fail();
      const state = JSON.parse(await file.readFile("utf8"));
      if (state?.version !== 1 || Object.keys(state).length !== 3 || Object.keys(state.binding ?? {}).length !== 4 || !Object.keys(bound).every(key => state.binding[key] === bound[key]) || !Array.isArray(state.records) || state.records.length > 128) return fail();
      const seen = new Set();
      for (const record of state.records) {
        if (!record || Object.keys(record).length !== 5 || !id(record.transferId) || seen.has(record.transferId) || !/^[a-f0-9]{64}$/.test(record.digest) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 1) return fail();
        seen.add(record.transferId);
        if (record.status === "pending") {
          if (record.envelope?.context?.transferId !== record.transferId || record.envelope.context.expiresAt !== record.expiresAt || verify(record.envelope, record.expiresAt - 1) !== record.digest) return fail();
        } else if (!terminal.includes(record.status) || record.envelope !== null) return fail();
      }
      return state;
    } catch (error) { if (!existed && error?.code === "ENOENT") return { version: 1, binding: { ...bound }, records: [] }; return fail(); }
    finally { await file?.close(); }
  }
  async function save(state) {
    const temporary = `${path}.${randomUUID()}.tmp`; let file;
    try {
      const content = JSON.stringify(state);
      if (Buffer.byteLength(content) > 1048576) return fail();
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(content); await file.sync(); await file.close(); file = undefined;
      await chmod(temporary, 0o600); await rename(temporary, path);
      if (process.platform !== "win32") {
        const parent = await open(dirname(path), constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally { await file?.close(); await unlink(temporary).catch(() => undefined); }
  }
  const mutate = operation => exclusive(async () => {
    await fingerprintDiagnosticOperation("local_state_review", directory); let lock;
    try {
      lock = await fingerprintDiagnosticOperation("local_state_review", () => acquireFingerprintStateLock(`${path}.lock`));
      const state = await fingerprintDiagnosticOperation("local_state_review", load);
      for (const record of state.records) if (record.status === "pending" && record.expiresAt <= now()) { record.status = "expired"; record.envelope = null; }
      const result = operation(state); await fingerprintDiagnosticOperation("local_state_review", () => save(state)); return structuredClone(result);
    } finally { if (lock) await fingerprintDiagnosticOperation("local_state_review", () => lock.close()); }
  });
  return {
    enqueue(envelope) {
      // Copy immediately so callers cannot mutate a queued asynchronous request.
      const copy = structuredClone(envelope);
      return mutate(state => {
        const digest = verify(copy, now()), c = copy.context;
        const previous = state.records.find(record => record.transferId === c.transferId);
        if (previous) { if (previous.digest !== digest) return fail(); return { transferId: previous.transferId, status: previous.status }; }
        // Retain terminal identities until their signed expiry to prevent revival.
        state.records = state.records.filter(record => record.status === "pending" || record.expiresAt > now());
        if (state.records.length >= 128) return fail();
        state.records.push({ transferId: c.transferId, digest, expiresAt: c.expiresAt, status: "pending", envelope: copy });
        return { transferId: c.transferId, status: "pending" };
      });
    },
    pending: () => mutate(state => state.records.filter(record => record.status === "pending")),
    status: () => mutate(state => state.records.map(({ envelope, ...metadata }) => metadata)),
    finish: (transferId, digest, status) => mutate(state => {
      if (!terminal.includes(status)) return fail();
      const record = state.records.find(record => record.transferId === transferId);
      if (!record || record.digest !== digest || (record.status !== "pending" && record.status !== status)) return fail();
      record.status = status; record.envelope = null;
      return { transferId, status };
    }),
  };
}
