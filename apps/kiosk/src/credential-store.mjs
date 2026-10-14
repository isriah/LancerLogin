import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeIdentityMethod } from "./identity-methods.mjs";

const credentialMethods = new Set(["rfid", "nfc", "qr"]);

function cleanCredential(value) {
  const credential = typeof value === "string" ? value.trim() : "";
  if (!credential || credential.length > 256 || /[\u0000-\u001f\u007f]/.test(credential)) throw new Error("Credential input must contain 1 to 256 printable characters");
  return credential;
}

function cleanMemberId(value) {
  const memberId = typeof value === "string" ? value.trim() : "";
  if (!memberId || memberId.length > 100 || /[\u0000-\u001f\u007f]/.test(memberId)) throw new Error("Choose an active roster member");
  return memberId;
}

function cleanLabel(value, method) {
  const label = typeof value === "string" ? value.trim() : "";
  if (label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("Credential label must be at most 60 printable characters");
  return label || `${method.toUpperCase()} credential`;
}

export function createCredentialStore(path, { secretBytes = () => randomBytes(32), id = () => randomUUID(), now = () => new Date().toISOString() } = {}) {
  let state;
  let operations = Promise.resolve();
  function exclusive(operation) { const result = operations.then(operation); operations = result.then(() => undefined, () => undefined); return result; }
  async function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (parsed?.version !== 1 || typeof parsed.secret !== "string" || !Array.isArray(parsed.mappings)) throw new Error("Credential mappings have an invalid format");
      const secret = Buffer.from(parsed.secret, "base64");
      if (secret.length !== 32 || parsed.mappings.some((mapping) => !mapping || typeof mapping.id !== "string" || !credentialMethods.has(mapping.method) || typeof mapping.memberId !== "string" || typeof mapping.digest !== "string" || !/^[0-9a-f]{64}$/.test(mapping.digest) || typeof mapping.label !== "string" || typeof mapping.createdAt !== "string")) throw new Error("Credential mappings have an invalid format");
      state = { version: 1, secret: parsed.secret, mappings: parsed.mappings };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      state = { version: 1, secret: Buffer.from(secretBytes()).toString("base64"), mappings: [] };
    }
    return state;
  }
  function digest(current, method, credential) { return createHmac("sha256", Buffer.from(current.secret, "base64")).update(method).update("\0").update(credential).digest("hex"); }
  async function persist(next) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(next)}\n`); await file.sync(); } finally { await file.close(); }
      await chmod(temporary, 0o600); await rename(temporary, path); state = next;
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  const publicMapping = ({ digest: _digest, ...mapping }) => ({ ...mapping });
  return {
    list() { return exclusive(async () => (await load()).mappings.map(publicMapping)); },
    resolve(methodValue, credentialValue) {
      return exclusive(async () => {
        const method = normalizeIdentityMethod(methodValue); if (!credentialMethods.has(method)) throw new Error("This authentication method does not use credential mappings");
        const credential = cleanCredential(credentialValue); const current = await load(); const expected = Buffer.from(digest(current, method, credential), "hex");
        const mapping = current.mappings.find((item) => { const actual = Buffer.from(item.digest, "hex"); return actual.length === expected.length && timingSafeEqual(actual, expected) && item.method === method; });
        return mapping ? publicMapping(mapping) : undefined;
      });
    },
    add({ method: methodValue, credential: credentialValue, memberId: memberIdValue, label, replaceExisting = false }) {
      return exclusive(async () => {
        const method = normalizeIdentityMethod(methodValue); if (!credentialMethods.has(method)) throw new Error("Choose RFID badge, NFC badge, or QR code");
        const credential = cleanCredential(credentialValue); const memberId = cleanMemberId(memberIdValue); const current = await load(); const credentialDigest = digest(current, method, credential);
        const existing = current.mappings.find((mapping) => mapping.method === method && mapping.digest === credentialDigest);
        if (existing && !replaceExisting) throw new Error("This credential is already mapped; confirm replacement to continue");
        if (!existing && current.mappings.length >= 1_000) throw new Error("This kiosk has reached the credential mapping limit");
        const mapping = { id: existing?.id ?? id(), method, memberId, digest: credentialDigest, label: cleanLabel(label, method), createdAt: existing?.createdAt ?? now() };
        const mappings = existing ? current.mappings.map((item) => item.id === existing.id ? mapping : item) : [...current.mappings, mapping];
        await persist({ ...current, mappings }); return publicMapping(mapping);
      });
    },
    remove(mappingId) {
      return exclusive(async () => {
        if (typeof mappingId !== "string" || !mappingId || mappingId.length > 100) throw new Error("Invalid credential mapping");
        const current = await load(); const mappings = current.mappings.filter((mapping) => mapping.id !== mappingId);
        if (mappings.length === current.mappings.length) return false;
        await persist({ ...current, mappings }); return true;
      });
    },
  };
}
