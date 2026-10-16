import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { fingerprintVaultBase64, fingerprintVaultDecode, fingerprintVaultDigest, fingerprintVaultFormat, fingerprintVaultId, fingerprintVaultKeyId, openFingerprintVault, sealFingerprintVault } from "./fingerprint-vault-crypto.ts";
import { fingerprintResetGuard } from "./fingerprint-reset.ts";

type Actor = { kind: "admin"; userId: string } | { kind: "kiosk"; id: string; pairingId: string; pairingBound: boolean; credentialHash: string };
type Context = { db: D1Database; actor: Actor; secret?: string; readJson(request: Request, limit: number): Promise<unknown>; respond(value: unknown, status?: number): Response };
type Settings = { vaultId: string; keyId: string; enabled: number };
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)));
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const hexId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const memberIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const randomId = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const attendanceAuthority = `EXISTS(SELECT 1 FROM platform_modules p WHERE p.installation_id='primary' AND p.module_id='attendance' AND p.phase='enabled')`;
const adminAuthority = `EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND active=1 AND role='admin')`;
const kioskAuthority = `EXISTS(SELECT 1 FROM kiosks k WHERE k.installation_id='primary' AND k.id=? AND k.active=1 AND k.pairing_bound=1 AND k.pairing_code_id=? AND k.token_hash=?) AND ${fingerprintResetGuard}`;
const shareableTemplate = `NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_retired_review_grants r WHERE r.installation_id=t.installation_id AND r.grant_id=t.enrollment_id)`;

/** Durable server-decryptable vault boundary. Templates are kiosk-only responses,
 * never dashboard data. Authentication and maintenance gates belong at composition.
 * Every database operation also checks current module, member and actor authority.
 */
export async function fingerprintVaultRoute(request: Request, context: Context): Promise<Response> {
  const { db, actor, readJson, respond, secret } = context;
  const url = new URL(request.url), path = url.pathname;
  const queryFields: string[] = []; url.searchParams.forEach((_value, key) => queryFields.push(key));
  if (actor.kind === "admin") {
    if (path !== "/admin/kiosks/fingerprint-vault") throw new HttpError(404, "Not found");
    if (request.method === "PATCH") {
      const input = await readJson(request, 1024);
      if (!exact(input, ["enabled", "confirmation"]) || typeof input.enabled !== "boolean" || input.confirmation !== (input.enabled ? "ENABLE CLOUD FINGERPRINT STORAGE" : "DISABLE CLOUD FINGERPRINT STORAGE")) throw new HttpError(400, "Confirm the fingerprint cloud-storage privacy change");
      const keyId = input.enabled ? await fingerprintVaultKeyId(secret) : null;
      const previous = await db.prepare("SELECT vault_id AS vaultId,key_id AS keyId,enabled FROM kiosk_fingerprint_vault_settings WHERE installation_id='primary'").first<Settings>();
      if (input.enabled && previous?.enabled && previous.keyId !== keyId) throw new HttpError(503, "The vault key changed. Recover the original FINGERPRINT_VAULT_KEY before enabling stored fingerprints. Do not replace stored data to bypass recovery.");
      const result = await db.batch([
        db.prepare(`INSERT INTO kiosk_fingerprint_vault_settings(installation_id,vault_id,key_id,enabled,updated_at)
          SELECT 'primary',?,?,?,? WHERE ${adminAuthority} AND ${attendanceAuthority}
          ON CONFLICT(installation_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,
            vault_id=CASE WHEN kiosk_fingerprint_vault_settings.enabled=1 THEN kiosk_fingerprint_vault_settings.vault_id ELSE excluded.vault_id END,
            key_id=CASE WHEN excluded.enabled=0 THEN kiosk_fingerprint_vault_settings.key_id ELSE excluded.key_id END
          WHERE excluded.enabled=0 OR kiosk_fingerprint_vault_settings.enabled=0 OR kiosk_fingerprint_vault_settings.key_id=excluded.key_id`)
          .bind(randomId(), keyId ?? previous?.keyId ?? "0".repeat(64), input.enabled ? 1 : 0, Date.now(), actor.userId),
        db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
          SELECT ?,'primary',?,'kiosk.fingerprint_vault_configured','installation','primary',?,? WHERE changes()>0`)
          .bind(crypto.randomUUID(), actor.userId, JSON.stringify({ enabled: input.enabled, serverManagedKeys: true }), new Date().toISOString()),
      ]);
      if (!result[0]?.meta?.changes) throw new HttpError(409, "Fingerprint storage authority or key configuration changed");
    } else if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
    const settings = await db.prepare(`SELECT vault_id AS vaultId,key_id AS keyId,enabled FROM kiosk_fingerprint_vault_settings
      WHERE installation_id='primary' AND ${adminAuthority} AND ${attendanceAuthority}`).bind(actor.userId).first<Settings>();
    let keyStatus = "missing";
    try { const id = await fingerprintVaultKeyId(secret); keyStatus = settings?.enabled && settings.keyId !== id ? "changed" : "ready"; } catch { /* Never disclose secret values or parser diagnostics. */ }
    const count = await db.prepare(`SELECT count(*) AS total FROM kiosk_fingerprint_vault_templates t WHERE t.installation_id='primary' AND ${shareableTemplate} AND ${adminAuthority} AND ${attendanceAuthority}`).bind(actor.userId).first<{ total: number }>();
    return respond({ enabled: Boolean(settings?.enabled), keyStatus, storedFingerprints: count?.total ?? 0, serverManagedKeys: true });
  }
  if (!actor.pairingBound) throw new HttpError(409, "Re-pair this kiosk before using fingerprint cloud storage");
  const authorityBindings = [actor.id, actor.pairingId, actor.credentialHash, actor.id, actor.pairingId];
  const settings = await db.prepare(`SELECT vault_id AS vaultId,key_id AS keyId,enabled FROM kiosk_fingerprint_vault_settings
    WHERE installation_id='primary' AND ${kioskAuthority} AND ${attendanceAuthority}`).bind(...authorityBindings).first<Settings>();
  if (path === "/kiosk/fingerprint-vault" && request.method === "GET") {
    if (!settings?.enabled) return respond({ enabled: false, vaultId: null });
    if (await fingerprintVaultKeyId(secret) !== settings.keyId) throw new HttpError(503, "Fingerprint cloud storage needs recovery of its original encryption key");
    return respond({ enabled: true, vaultId: settings.vaultId, format: fingerprintVaultFormat });
  }
  if (!settings?.enabled) throw new HttpError(409, "Fingerprint cloud storage is disabled");
  if (await fingerprintVaultKeyId(secret) !== settings.keyId) throw new HttpError(503, "Fingerprint cloud storage needs recovery of its original encryption key");
  const currentAuthority = `EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_settings v WHERE v.installation_id='primary' AND v.vault_id=? AND v.key_id=? AND v.enabled=1) AND ${kioskAuthority} AND ${attendanceAuthority}`;
  const currentBindings = [settings.vaultId, settings.keyId, ...authorityBindings];
  if (path === "/kiosk/fingerprint-vault/templates" && request.method === "POST") {
    const input = await readJson(request, 4096);
    if (!exact(input, ["vaultId", "memberId", "rosterId", "enrollmentId", "template"]) || input.vaultId !== settings.vaultId || !memberIdentifier(input.memberId) || !identifier(input.rosterId) || !identifier(input.enrollmentId)) throw new HttpError(400, "Invalid fingerprint vault enrollment");
    const sourceAuthority = `${currentAuthority} AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_retired_review_grants WHERE installation_id='primary' AND grant_id=?)`;
    const sourceBindings = [...currentBindings, input.enrollmentId];
    const template = fingerprintVaultDecode(input.template, 1536);
    try {
      const member = await db.prepare(`SELECT id FROM members WHERE installation_id='primary' AND external_id=? AND id=? AND active=1 AND ${sourceAuthority}`).bind(input.memberId, input.rosterId, ...sourceBindings).first<{ id: string }>();
      if (!member) throw new HttpError(409, "Fingerprint member or kiosk authority is unavailable");
      const templateDigest = await fingerprintVaultDigest(secret!, template);
      const binding = { vaultId: settings.vaultId, keyId: settings.keyId, memberId: member.id, templateDigest, fingerprintId: "", sourceKioskId: actor.id, sourcePairingId: actor.pairingId, enrollmentId: input.enrollmentId, createdAt: Date.now() };
      binding.fingerprintId = await fingerprintVaultId(binding);
      const encrypted = await sealFingerprintVault(template, binding, secret!);
      try {
        await db.prepare(`INSERT INTO kiosk_fingerprint_vault_templates(fingerprint_id,installation_id,vault_id,member_id,template_digest,ciphertext,nonce,format,source_kiosk_id,source_pairing_id,enrollment_id,created_at)
          SELECT ?,'primary',?,?,?,?,?,?,?,?,?,? WHERE ${sourceAuthority}
            AND EXISTS(SELECT 1 FROM members WHERE installation_id='primary' AND id=? AND external_id=? AND active=1)
            AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_templates WHERE installation_id='primary' AND vault_id=? AND template_digest=?)`)
          .bind(binding.fingerprintId, settings.vaultId, member.id, templateDigest, encrypted.ciphertext, encrypted.nonce, fingerprintVaultFormat, actor.id, actor.pairingId, input.enrollmentId, binding.createdAt,
            ...sourceBindings, member.id, input.memberId, settings.vaultId, templateDigest).run();
      } catch { throw new HttpError(409, "Fingerprint cloud storage authority or capacity changed"); }
      const saved = await db.prepare(`SELECT fingerprint_id AS fingerprintId FROM kiosk_fingerprint_vault_templates WHERE installation_id='primary' AND vault_id=? AND fingerprint_id=? AND member_id=? AND ${sourceAuthority}
        AND EXISTS(SELECT 1 FROM members WHERE installation_id='primary' AND id=? AND external_id=? AND active=1)`)
        .bind(settings.vaultId, binding.fingerprintId, member.id, ...sourceBindings, member.id, input.memberId).first<{ fingerprintId: string }>();
      if (!saved) throw new HttpError(409, "Fingerprint cloud enrollment is unavailable or conflicts with an existing member binding");
      return respond({ stored: true, fingerprintId: saved.fingerprintId }, 200);
    } finally { template.fill(0); }
  }
  if (path === "/kiosk/fingerprint-vault/templates" && request.method === "GET") {
    const afters = url.searchParams.getAll("after"), after = afters[0] ?? "";
    if (afters.length > 1 || afters.length && !hexId(after) || queryFields.some(key => key !== "after")) throw new HttpError(400, "Invalid fingerprint vault cursor");
    const rows = await db.prepare(`SELECT t.fingerprint_id AS fingerprintId,m.external_id AS memberId,m.id AS rosterId FROM kiosk_fingerprint_vault_templates t
      CROSS JOIN members m ON m.id=t.member_id AND m.installation_id=t.installation_id AND m.active=1
      WHERE t.installation_id='primary' AND t.vault_id=? AND t.fingerprint_id>? AND ${shareableTemplate} AND ${currentAuthority} ORDER BY t.fingerprint_id LIMIT 8`)
      .bind(settings.vaultId, after, ...currentBindings).all<{ fingerprintId: string; memberId: string; rosterId: string }>();
    return respond({ vaultId: settings.vaultId, fingerprints: rows.results ?? [] });
  }
  const item = /^\/kiosk\/fingerprint-vault\/templates\/([a-f0-9]{64})$/.exec(path);
  if (item && request.method === "GET") {
    if (queryFields.length) throw new HttpError(400, "Invalid fingerprint vault request");
    const record = await db.prepare(`SELECT t.fingerprint_id AS fingerprintId,t.member_id AS memberId,m.external_id AS externalId,t.template_digest AS templateDigest,t.ciphertext,t.nonce,
      t.source_kiosk_id AS sourceKioskId,t.source_pairing_id AS sourcePairingId,t.enrollment_id AS enrollmentId,t.created_at AS createdAt FROM kiosk_fingerprint_vault_templates t
      JOIN members m ON m.id=t.member_id AND m.installation_id=t.installation_id AND m.active=1
      WHERE t.installation_id='primary' AND t.vault_id=? AND t.fingerprint_id=? AND ${shareableTemplate} AND ${currentAuthority}`)
      .bind(settings.vaultId, item[1], ...currentBindings).first<{ fingerprintId: string; memberId: string; externalId: string; templateDigest: string; ciphertext: string; nonce: string; sourceKioskId: string; sourcePairingId: string; enrollmentId: string; createdAt: number }>();
    if (!record) throw new HttpError(404, "Fingerprint cloud enrollment not found");
    const template = await openFingerprintVault(record, { ...record, vaultId: settings.vaultId, keyId: settings.keyId }, secret!);
    try {
      // Recheck after decryption so a concurrent retirement, key/configuration
      // change or member revocation cannot release data authorized by an old read.
      const valid = await db.prepare(`SELECT 1 AS valid FROM kiosk_fingerprint_vault_templates t JOIN members m ON m.id=t.member_id AND m.active=1 AND m.installation_id=t.installation_id
        WHERE t.installation_id='primary' AND t.vault_id=? AND t.fingerprint_id=? AND m.external_id=? AND ${shareableTemplate} AND ${currentAuthority}`)
        .bind(settings.vaultId, record.fingerprintId, record.externalId, ...currentBindings).first();
      if (!valid) throw new HttpError(409, "Fingerprint cloud enrollment authority changed");
      return respond({ vaultId: settings.vaultId, fingerprintId: record.fingerprintId, memberId: record.externalId, rosterId: record.memberId, format: fingerprintVaultFormat, template: fingerprintVaultBase64(template) });
    } finally { template.fill(0); }
  }
  throw new HttpError(404, "Not found");
}
