import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, generateKeyPair, privateDecrypt, publicEncrypt, randomBytes, sign, verify } from "node:crypto";
import { promisify } from "node:util";
import { r503TemplateBytes } from "./r503-template-transfer.mjs";

const generate = promisify(generateKeyPair);
const domain = "LancerLogin fingerprint sync v1";
const contextFields = ["installationId", "senderId", "recipientId", "senderPairingId", "recipientPairingId", "memberId", "enrollmentId", "transferId", "senderKeyId", "recipientKeyId", "revision", "issuedAt", "expiresAt"];
const fail = () => { throw new Error("Fingerprint transfer could not be authenticated"); };
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const encode = (bytes) => Buffer.from(bytes).toString("base64");
const decode = (value, bytes) => {
  if (typeof value !== "string" || value.length !== Math.ceil(bytes / 3) * 4) return fail();
  const result = Buffer.from(value, "base64");
  if (result.length !== bytes || encode(result) !== value) return fail();
  return result;
};

export async function generateFingerprintIdentity() {
  const encryption = await generate("rsa", { modulusLength: 3072, publicExponent: 65537 });
  const signing = await generate("ed25519");
  return { encryption, signing };
}

export function fingerprintPublicIdentity(identity) {
  return {
    encryption: identity.encryption.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    signing: identity.signing.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function publicKeys(identity) {
  if (!exactKeys(identity, ["encryption", "signing"])) return fail();
  // Canonical DER lengths for the exact generated RSA-3072 and Ed25519 profile.
  const encryption = createPublicKey({ key: decode(identity.encryption, 422), type: "spki", format: "der" });
  const signing = createPublicKey({ key: decode(identity.signing, 44), type: "spki", format: "der" });
  if (encryption.asymmetricKeyType !== "rsa" || encryption.asymmetricKeyDetails?.modulusLength !== 3072 || encryption.asymmetricKeyDetails?.publicExponent !== 65537n || signing.asymmetricKeyType !== "ed25519") return fail();
  if (encode(encryption.export({ type: "spki", format: "der" })) !== identity.encryption || encode(signing.export({ type: "spki", format: "der" })) !== identity.signing) return fail();
  return { encryption, signing };
}

// Verify this fingerprint through an independently approved local trust flow.
// Merely receiving keys from the relay does not authorize them.
export function fingerprintIdentityId(identity) {
  publicKeys(identity);
  return createHash("sha256").update(JSON.stringify([domain, identity.encryption, identity.signing])).digest("hex");
}

function contextBytes(context, now) {
  if (!exactKeys(context, contextFields) || !Number.isSafeInteger(now)) return fail();
  for (const field of contextFields.slice(0, 10)) {
    if (field === "memberId") {
      if (typeof context[field] !== "string" || !context[field].length || context[field].length > 100 || context[field] !== context[field].trim() || /[\u0000-\u001f\u007f]/.test(context[field])) return fail();
      continue;
    }
    if (typeof context[field] !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(context[field])) return fail();
  }
  if (!/^[a-f0-9]{64}$/.test(context.senderKeyId) || !/^[a-f0-9]{64}$/.test(context.recipientKeyId)) return fail();
  if (context.senderId === context.recipientId || !Number.isSafeInteger(context.revision) || context.revision < 1) return fail();
  if (!Number.isSafeInteger(context.issuedAt) || !Number.isSafeInteger(context.expiresAt) || context.issuedAt < 0 || context.issuedAt > now + 300000 || context.expiresAt <= now || context.expiresAt <= context.issuedAt || context.expiresAt - context.issuedAt > 7 * 86400000) return fail();
  return Buffer.from(JSON.stringify([domain, "r503-model-1536", ...contextFields.map((key) => context[key])]));
}

function signedBytes(aad, envelope) {
  return Buffer.from(JSON.stringify([aad.toString("base64"), envelope.wrappedKey, envelope.nonce, envelope.ciphertext, envelope.tag]));
}

export function sealFingerprintTemplate(template, { sender, recipient, context, now = Date.now() }) {
  let key;
  try {
    if (!(template instanceof Uint8Array) || template.length !== r503TemplateBytes) return fail();
    const aad = contextBytes(context, now);
    if (context.senderKeyId !== fingerprintIdentityId(fingerprintPublicIdentity(sender)) || context.recipientKeyId !== fingerprintIdentityId(recipient)) return fail();
    const target = publicKeys(recipient);
    key = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(template), cipher.final()]);
    const wrappedKey = publicEncrypt({ key: target.encryption, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: aad }, key);
    const envelope = { version: 1, context: { ...context }, wrappedKey: encode(wrappedKey), nonce: encode(nonce), ciphertext: encode(ciphertext), tag: encode(cipher.getAuthTag()) };
    return { ...envelope, signature: encode(sign(null, signedBytes(aad, envelope), sender.signing.privateKey)) };
  } catch { return fail(); }
  finally { key?.fill(0); }
}

// Verify ciphertext without decrypting it, for durable outbound storage. The
// signature digest is also the relay acknowledgement and receiver journal ID.
export function fingerprintEnvelopeDigest(envelope, { sender, expected, now = Date.now() }) {
  try {
    if (!exactKeys(envelope, ["version", "context", "wrappedKey", "nonce", "ciphertext", "tag", "signature"]) || envelope.version !== 1) return fail();
    const aad = contextBytes(envelope.context, now);
    if (!exactKeys(expected, contextFields) || !contextBytes(expected, now).equals(aad) || envelope.context.senderKeyId !== fingerprintIdentityId(sender)) return fail();
    decode(envelope.wrappedKey, 384); decode(envelope.nonce, 12); decode(envelope.ciphertext, r503TemplateBytes); decode(envelope.tag, 16);
    const signature = decode(envelope.signature, 64);
    if (!verify(null, signedBytes(aad, envelope), publicKeys(sender).signing, signature)) return fail();
    return createHash("sha256").update(signature).digest("hex");
  } catch { return fail(); }
}

// expected is supplied from local trusted state, never copied from the envelope.
// A durable delivery journal must additionally enforce replay/idempotency policy.
export function openFingerprintTemplate(envelope, { recipient, sender, expected, now = Date.now() }) {
  let key, provisional, tail;
  try {
    if (!exactKeys(envelope, ["version", "context", "wrappedKey", "nonce", "ciphertext", "tag", "signature"]) || envelope.version !== 1) return fail();
    const aad = contextBytes(envelope.context, now);
    if (!exactKeys(expected, contextFields) || !contextBytes(expected, now).equals(aad)) return fail();
    if (envelope.context.senderKeyId !== fingerprintIdentityId(sender) || envelope.context.recipientKeyId !== fingerprintIdentityId(fingerprintPublicIdentity(recipient))) return fail();
    const source = publicKeys(sender);
    const wrappedKey = decode(envelope.wrappedKey, 384), nonce = decode(envelope.nonce, 12), ciphertext = decode(envelope.ciphertext, r503TemplateBytes), tag = decode(envelope.tag, 16), signature = decode(envelope.signature, 64);
    if (!verify(null, signedBytes(aad, envelope), source.signing, signature)) return fail();
    key = privateDecrypt({ key: recipient.encryption.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: aad }, wrappedKey);
    if (key.length !== 32) return fail();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    provisional = decipher.update(ciphertext);
    tail = decipher.final();
    return Buffer.concat([provisional, tail]);
  } catch { return fail(); }
  finally { key?.fill(0); provisional?.fill(0); tail?.fill(0); }
}
