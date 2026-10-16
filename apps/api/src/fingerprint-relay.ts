import { preserveDatabaseIdentity, type D1Database, type D1Statement } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { fingerprintResetGuard } from "./fingerprint-reset.ts";

// Only fixed SQL column expressions below are substituted, never request data.
const sourceResetGuard = fingerprintResetGuard.replace("?", "ak.id").replace("?", "a.pairing_id");
const recipientResetGuard = fingerprintResetGuard.replace("?", "bk.id").replace("?", "b.pairing_id");
const peerResetGuard = fingerprintResetGuard.replace("?", "p.kiosk_id").replace("?", "p.pairing_id");

type Actor = { kind: "admin"; userId: string } | { kind: "kiosk"; id: string; pairingId: string; pairingBound: boolean; credentialHash: string };
type Context = { db: D1Database; actor: Actor; readJson(request: Request, limit: number): Promise<unknown>; respond(value: unknown, status?: number): Response };
type PublicIdentity = { encryption: string; signing: string };
const contextFields = ["installationId", "senderId", "recipientId", "senderPairingId", "recipientPairingId", "memberId", "enrollmentId", "transferId", "senderKeyId", "recipientKeyId", "revision", "issuedAt", "expiresAt"];
type EnvelopeContext = Record<(typeof contextFields)[number], string | number>;
type Envelope = { version: number; context: EnvelopeContext; wrappedKey: string; nonce: string; ciphertext: string; tag: string; signature: string };
const transferError = () => new HttpError(400, "Invalid fingerprint transfer");
const encodeText = (text: string) => new TextEncoder().encode(text);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function parseEnvelope(value: unknown, now: number): Envelope {
  if (!exact(value, ["version", "context", "wrappedKey", "nonce", "ciphertext", "tag", "signature"]) || value.version !== 1 || !exact(value.context, contextFields)) throw transferError();
  const c = value.context;
  for (const field of contextFields.slice(0, 10)) {
    const value = c[field];
    if (typeof value !== "string") throw transferError();
    if (field === "memberId") {
      if (!value.length || value.length > 100 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw transferError();
    } else if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw transferError();
  }
  if (!/^[a-f0-9]{64}$/.test(c.senderKeyId as string) || !/^[a-f0-9]{64}$/.test(c.recipientKeyId as string) || c.senderId === c.recipientId) throw transferError();
  if (!Number.isSafeInteger(c.revision) || (c.revision as number) < 1 || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt)) throw transferError();
  const issuedAt = c.issuedAt as number, expiresAt = c.expiresAt as number;
  if (issuedAt < 0 || issuedAt > now + 300000 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 604800000) throw transferError();
  try {
    decode(value.wrappedKey, 384); decode(value.nonce, 12); decode(value.ciphertext, 1536); decode(value.tag, 16); decode(value.signature, 64);
  } catch { throw transferError(); }
  return { version: 1, context: Object.fromEntries(contextFields.map(key => [key, c[key]])) as EnvelopeContext, wrappedKey: value.wrappedKey as string, nonce: value.nonce as string, ciphertext: value.ciphertext as string, tag: value.tag as string, signature: value.signature as string };
}
// Every read and acknowledgement binds both current pairings and registrations,
// not just the bearer token that authenticated the start of the request.
export const fingerprintDeliveryAuthority = `FROM kiosk_fingerprint_deliveries d
  JOIN kiosk_fingerprint_sync s ON s.installation_id=d.installation_id AND s.sync_id=d.sync_id AND s.enabled=1
  JOIN kiosk_fingerprint_keys a ON a.kiosk_id=d.sender_id AND a.installation_id=d.installation_id AND a.pairing_id=d.sender_pairing_id AND a.key_id=d.sender_key_id
  JOIN kiosk_fingerprint_keys b ON b.kiosk_id=d.recipient_id AND b.installation_id=d.installation_id AND b.pairing_id=d.recipient_pairing_id AND b.key_id=d.recipient_key_id
  JOIN kiosks ak ON ak.id=a.kiosk_id AND ak.active=1 AND ak.pairing_code_id=a.pairing_id AND ${sourceResetGuard}
  JOIN kiosks bk ON bk.id=b.kiosk_id AND bk.active=1 AND bk.pairing_code_id=b.pairing_id AND ${recipientResetGuard}
  JOIN members m ON m.id=d.member_id AND m.installation_id=d.installation_id AND m.active=1`;
const deliveryAuthority = fingerprintDeliveryAuthority;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
const invalid = () => new HttpError(400, "Invalid fingerprint sync public identity");
function decode(value: unknown, length: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length !== Math.ceil(length / 3) * 4) throw invalid();
  try {
    const text = atob(value); const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
    if (bytes.length !== length || btoa(String.fromCharCode(...bytes)) !== value) throw invalid();
    return bytes;
  } catch { throw invalid(); }
}
async function validateIdentity(value: unknown): Promise<{ publicIdentity: PublicIdentity; fingerprint: string }> {
  if (!exact(value, ["publicIdentity", "fingerprint"]) || !exact(value.publicIdentity, ["encryption", "signing"]) || typeof value.fingerprint !== "string") throw invalid();
  const encryption = decode(value.publicIdentity.encryption, 422), signing = decode(value.publicIdentity.signing, 44);
  try {
    const key = await crypto.subtle.importKey("spki", encryption, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
    const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
    if (algorithm.modulusLength !== 3072 || [...algorithm.publicExponent].join(",") !== "1,0,1") throw invalid();
    await crypto.subtle.importKey("spki", signing, { name: "Ed25519" }, false, ["verify"]);
    const publicIdentity = value.publicIdentity as PublicIdentity;
    const encoded = new TextEncoder().encode(JSON.stringify(["LancerLogin fingerprint sync v1", publicIdentity.encryption, publicIdentity.signing]));
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (value.fingerprint !== fingerprint) throw invalid();
    return { publicIdentity, fingerprint };
  } catch { throw invalid(); }
}

/** Recheck the request credential atomically, including after asynchronous crypto. */
function captureKioskCredential(db: D1Database, actor: Extract<Actor, { kind: "kiosk" }>): D1Database {
  const originals = new WeakMap<D1Statement, D1Statement>();
  const guard = () => db.prepare(`SELECT CASE WHEN EXISTS(
    SELECT 1 FROM kiosks WHERE installation_id='primary' AND id=? AND pairing_code_id=?
      AND token_hash=? AND active=1 AND pairing_bound=1
    ) THEN 1 ELSE json_extract('{}','fingerprint-credential-unavailable') END AS credential_available`)
    .bind(actor.id, actor.pairingId, actor.credentialHash);
  async function batch(statements: D1Statement[]) {
    const input = statements.map((statement) => {
      const original = originals.get(statement);
      if (!original) throw new HttpError(500, "Fingerprint statement belongs to a different request");
      return original;
    });
    try { return (await db.batch([guard(), ...input, guard()])).slice(1, -1); }
    catch (error) {
      if (error instanceof Error && error.message.includes("fingerprint-credential-unavailable")) {
        throw new HttpError(409, "Kiosk credential changed. Reload or re-pair this kiosk.");
      }
      throw error;
    }
  }
  function wrap(original: D1Statement): D1Statement {
    const statement: D1Statement = {
      bind: (...values) => wrap(original.bind(...values)),
      first: async <T>() => ((await batch([statement]))[0]?.results?.[0] as T | undefined) ?? null,
      all: async <T>() => (await batch([statement]))[0] as Awaited<ReturnType<D1Statement["all"]>> & { results?: T[] },
      run: async () => (await batch([statement]))[0]!,
    };
    originals.set(statement, original);
    return statement;
  }
  return preserveDatabaseIdentity({ prepare: (sql) => wrap(db.prepare(sql)), batch }, db);
}

export async function fingerprintRelayRoute(request: Request, context: Context): Promise<Response> {
  const { db: database, actor, readJson, respond } = context;
  let db = database;
  const path = new URL(request.url).pathname;
  if (actor.kind === "admin") {
    if (path !== "/admin/kiosks/fingerprint-sync") throw new HttpError(404, "Not found");
    if (request.method === "PATCH") {
      const input = await readJson(request, 1024);
      if (!exact(input, ["enabled"]) || typeof input.enabled !== "boolean") throw new HttpError(400, "Choose whether fingerprint sync is enabled");
      const syncId = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await db.batch([
        db.prepare(`INSERT INTO kiosk_fingerprint_sync(installation_id,sync_id,enabled)
          SELECT 'primary',?,? WHERE EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND active=1 AND role='admin')
          ON CONFLICT(installation_id) DO UPDATE SET enabled=excluded.enabled`).bind(syncId, input.enabled ? 1 : 0, actor.userId),
        db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
          SELECT ?,'primary',?,'kiosk.fingerprint_sync_configured','installation','primary',?,? WHERE changes()>0`)
          .bind(crypto.randomUUID(), actor.userId, JSON.stringify({ enabled: input.enabled }), new Date().toISOString()),
      ]);
      if (!result[0]?.meta?.changes) throw new HttpError(403, "Administrator authority changed");
    } else if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
    const state = await db.prepare("SELECT sync_id AS syncId,enabled FROM kiosk_fingerprint_sync WHERE installation_id='primary'").first<{ syncId: string; enabled: number }>();
    return respond({ enabled: Boolean(state?.enabled), syncId: state?.syncId ?? null });
  }
  if (!actor.pairingBound) throw new HttpError(409, "Re-pair this kiosk before enabling fingerprint sync");
  db = captureKioskCredential(database, actor);
  const state = await db.prepare(`SELECT s.sync_id AS syncId,s.enabled FROM kiosk_fingerprint_sync s
    JOIN kiosks k ON k.installation_id=s.installation_id WHERE s.installation_id='primary' AND k.id=? AND k.pairing_code_id=? AND k.active=1 AND ${fingerprintResetGuard}`)
    .bind(actor.id, actor.pairingId, actor.id, actor.pairingId).first<{ syncId: string; enabled: number }>();
  if (path === "/kiosk/fingerprint-sync" && request.method === "GET") return respond({ enabled: Boolean(state?.enabled), syncId: state?.syncId ?? null });
  if (!state?.enabled) throw new HttpError(409, "Fingerprint sync is disabled");
  // Purge bounded operational rows, rather than retaining expired ciphertext.
  await db.prepare("DELETE FROM kiosk_fingerprint_deliveries WHERE installation_id='primary' AND expires_at<=?").bind(Date.now()).run();
  if (path === "/kiosk/fingerprint-sync/identity" && request.method === "PUT") {
    const identity = await validateIdentity(await readJson(request, 2048));
    const publicJson = JSON.stringify(identity.publicIdentity);
    try {
      await db.prepare(`INSERT INTO kiosk_fingerprint_keys(kiosk_id,installation_id,pairing_id,key_id,public_json,registered_at)
        SELECT k.id,k.installation_id,k.pairing_code_id,?,?,? FROM kiosks k JOIN kiosk_fingerprint_sync s ON s.installation_id=k.installation_id
        WHERE k.installation_id='primary' AND k.id=? AND k.active=1 AND k.pairing_code_id=? AND s.enabled=1 AND s.sync_id=? AND ${fingerprintResetGuard}
        ON CONFLICT(kiosk_id) DO NOTHING`).bind(identity.fingerprint, publicJson, Date.now(), actor.id, actor.pairingId, state.syncId, actor.id, actor.pairingId).run();
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(409, "Kiosk sync authority changed"); }
    const registered = await db.prepare(`SELECT p.key_id AS keyId,p.public_json AS publicJson FROM kiosk_fingerprint_keys p
      JOIN kiosks k ON k.id=p.kiosk_id AND k.active=1 AND k.pairing_code_id=p.pairing_id
      JOIN kiosk_fingerprint_sync s ON s.installation_id=p.installation_id AND s.enabled=1
      WHERE p.installation_id='primary' AND p.kiosk_id=? AND p.pairing_id=? AND s.sync_id=? AND ${fingerprintResetGuard}`)
      .bind(actor.id, actor.pairingId, state.syncId, actor.id, actor.pairingId).first<{ keyId: string; publicJson: string }>();
    if (!registered || registered.keyId !== identity.fingerprint || registered.publicJson !== publicJson) throw new HttpError(409, "Revoke the previous sync identity before replacing it");
    return respond({ registered: true, fingerprint: registered.keyId });
  }
  if (path === "/kiosk/fingerprint-sync/identity" && request.method === "DELETE") {
    await db.prepare("DELETE FROM kiosk_fingerprint_keys WHERE installation_id='primary' AND kiosk_id=? AND pairing_id=?").bind(actor.id, actor.pairingId).run();
    return respond({ revoked: true });
  }
  if (path === "/kiosk/fingerprint-sync/peers" && request.method === "GET") {
    const peers = await db.prepare(`SELECT p.kiosk_id AS kioskId,p.pairing_id AS pairingId,p.key_id AS fingerprint,p.public_json AS publicJson,k.name
      FROM kiosk_fingerprint_keys p JOIN kiosks k ON k.id=p.kiosk_id AND k.active=1 AND k.pairing_code_id=p.pairing_id
      JOIN kiosk_fingerprint_sync s ON s.installation_id=p.installation_id AND s.enabled=1 AND s.sync_id=?
      WHERE p.installation_id='primary' AND p.kiosk_id<>? AND EXISTS(SELECT 1 FROM kiosks me WHERE me.id=? AND me.active=1 AND me.pairing_code_id=?)
        AND ${fingerprintResetGuard} AND ${peerResetGuard}
      ORDER BY k.name LIMIT 32`).bind(state.syncId, actor.id, actor.id, actor.pairingId, actor.id, actor.pairingId).all<{ kioskId: string; pairingId: string; fingerprint: string; publicJson: string; name: string }>();
    return respond({ peers: (peers.results ?? []).map(({ publicJson, ...peer }) => ({ ...peer, installationId: state.syncId, publicIdentity: JSON.parse(publicJson) })) });
  }
  if (path === "/kiosk/fingerprint-sync/deliveries" && request.method === "POST") {
    const envelope = parseEnvelope(await readJson(request, 8192), Date.now()), c = envelope.context;
    if (c.installationId !== state.syncId || c.senderId !== actor.id || c.senderPairingId !== actor.pairingId) throw new HttpError(403, "Fingerprint transfer sender does not match this kiosk");
    const source = await db.prepare(`SELECT p.public_json AS publicJson FROM kiosk_fingerprint_keys p
      JOIN kiosks k ON k.id=p.kiosk_id AND k.active=1 AND k.pairing_code_id=p.pairing_id
      WHERE p.installation_id='primary' AND p.kiosk_id=? AND p.pairing_id=? AND p.key_id=? AND ${fingerprintResetGuard}`)
      .bind(actor.id, actor.pairingId, c.senderKeyId, actor.id, actor.pairingId).first<{ publicJson: string }>();
    if (!source) throw new HttpError(409, "Register this kiosk's sync identity first");
    try {
      const publicIdentity = JSON.parse(source.publicJson) as PublicIdentity;
      const key = await crypto.subtle.importKey("spki", decode(publicIdentity.signing, 44), { name: "Ed25519" }, false, ["verify"]);
      const aad = encodeText(JSON.stringify(["LancerLogin fingerprint sync v1", "r503-model-1536", ...contextFields.map(field => c[field])]));
      const signed = encodeText(JSON.stringify([base64(aad), envelope.wrappedKey, envelope.nonce, envelope.ciphertext, envelope.tag]));
      if (!await crypto.subtle.verify("Ed25519", key, decode(envelope.signature, 64), signed)) throw transferError();
    } catch { throw transferError(); }
    const envelopeDigest = await digest(decode(envelope.signature, 64));
    // INSERT SELECT makes member identity resolution part of the same statement.
    // The authority trigger rechecks both devices/keys and enablement atomically.
    try {
      await db.prepare(`INSERT INTO kiosk_fingerprint_deliveries(transfer_id,installation_id,sync_id,sender_id,recipient_id,sender_pairing_id,recipient_pairing_id,sender_key_id,recipient_key_id,member_id,envelope_digest,envelope_json,created_at,expires_at)
        SELECT ?,'primary',?,?,?,?,?,?,?,m.id,?,?,?,? FROM members m
        WHERE m.installation_id='primary' AND m.external_id=? AND m.active=1
          AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_deliveries WHERE transfer_id=?)`)
        .bind(c.transferId, c.installationId, c.senderId, c.recipientId, c.senderPairingId, c.recipientPairingId, c.senderKeyId, c.recipientKeyId,
          envelopeDigest, JSON.stringify(envelope), c.issuedAt, c.expiresAt, c.memberId, c.transferId).run();
    } catch { throw new HttpError(409, "Fingerprint delivery authority or capacity changed"); }
    const saved = await db.prepare(`SELECT d.status,d.envelope_digest AS digest ${deliveryAuthority}
      WHERE d.installation_id='primary' AND d.sync_id=? AND d.transfer_id=? AND d.sender_id=? AND d.sender_pairing_id=? AND d.expires_at>?`)
      .bind(state.syncId, c.transferId, actor.id, actor.pairingId, Date.now()).first<{ status: string; digest: string }>();
    if (!saved || saved.digest !== envelopeDigest) throw new HttpError(409, "Fingerprint transfer identity is unavailable or already used");
    return respond({ transferId: c.transferId, status: saved.status }, saved.status === "pending" ? 202 : 200);
  }
  if (path === "/kiosk/fingerprint-sync/deliveries" && request.method === "GET") {
    const cursors = new URL(request.url).searchParams.getAll("after");
    const after = cursors[0] ?? "";
    if (cursors.length > 1 || (cursors.length && !/^[A-Za-z0-9._:-]{1,128}$/.test(after))) throw transferError();
    // Keyset pagination survives acknowledgements/deletions between polls.
    // A blocked first page must not starve later, otherwise valid transfers.
    const pending = await db.prepare(`SELECT d.envelope_json AS envelopeJson ${deliveryAuthority}
      WHERE d.installation_id='primary' AND d.sync_id=? AND d.recipient_id=? AND d.recipient_pairing_id=? AND d.status='pending' AND d.expires_at>?
        AND d.transfer_id>?
      ORDER BY d.transfer_id LIMIT 8`).bind(state.syncId, actor.id, actor.pairingId, Date.now(), after).all<{ envelopeJson: string }>();
    return respond({ syncId: state.syncId, deliveries: (pending.results ?? []).map(row => JSON.parse(row.envelopeJson)) });
  }
  const deliveryPath = /^\/kiosk\/fingerprint-sync\/deliveries\/([A-Za-z0-9._:-]{1,128})(\/result)?$/.exec(path);
  if (deliveryPath) {
    const transferId = deliveryPath[1];
    if (deliveryPath[2] && request.method === "POST") {
      const input = await readJson(request, 1024);
      if (!exact(input, ["status", "digest"]) || !["complete", "needs_review", "rejected"].includes(input.status as string) || typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)) throw transferError();
      await db.prepare(`UPDATE kiosk_fingerprint_deliveries SET status=?,envelope_json=NULL WHERE status='pending' AND transfer_id IN (
        SELECT d.transfer_id ${deliveryAuthority} WHERE d.installation_id='primary' AND d.sync_id=? AND d.transfer_id=? AND d.recipient_id=? AND d.recipient_pairing_id=? AND d.envelope_digest=? AND d.expires_at>?)`)
        .bind(input.status, state.syncId, transferId, actor.id, actor.pairingId, input.digest, Date.now()).run();
      const saved = await db.prepare(`SELECT d.status ${deliveryAuthority} WHERE d.installation_id='primary' AND d.sync_id=? AND d.transfer_id=? AND d.recipient_id=? AND d.recipient_pairing_id=? AND d.envelope_digest=? AND d.expires_at>?`)
        .bind(state.syncId, transferId, actor.id, actor.pairingId, input.digest, Date.now()).first<{ status: string }>();
      if (!saved) throw new HttpError(404, "Fingerprint delivery not found");
      if (saved.status !== input.status) throw new HttpError(409, "Fingerprint delivery already has a different result");
      return respond({ transferId, status: saved.status });
    }
    if (!deliveryPath[2] && request.method === "GET") {
      const saved = await db.prepare(`SELECT d.status ${deliveryAuthority} WHERE d.installation_id='primary' AND d.sync_id=? AND d.transfer_id=? AND d.sender_id=? AND d.sender_pairing_id=? AND d.expires_at>?`)
        .bind(state.syncId, transferId, actor.id, actor.pairingId, Date.now()).first<{ status: string }>();
      if (!saved) throw new HttpError(404, "Fingerprint delivery not found");
      return respond({ transferId, status: saved.status });
    }
  }
  throw new HttpError(404, "Not found");
}
