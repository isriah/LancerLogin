import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { fingerprintVaultBase64, fingerprintVaultDecode, fingerprintVaultDigest, fingerprintVaultFormat, fingerprintVaultEnrollmentId, fingerprintVaultKeyId, openFingerprintVault, sealFingerprintVault } from "./fingerprint-vault-crypto.ts";
import { fingerprintResetGuard } from "./fingerprint-reset.ts";

type Actor = { kind: "admin"; userId: string } | { kind: "kiosk"; id: string; pairingId: string; pairingBound: boolean; credentialHash: string };
type Context = { db: D1Database; actor: Actor; secret?: string; readJson(request: Request, limit: number): Promise<unknown>; respond(value: unknown, status?: number): Response };
type Settings = { vaultId: string; keyId: string; enabled: number; catalogRevision: number };
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)));
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const hexId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const memberIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 100 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const randomId = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const attendanceAuthority = `EXISTS(SELECT 1 FROM platform_modules p WHERE p.installation_id='primary' AND p.module_id='attendance' AND p.phase='enabled')`;
const adminAuthority = `EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND active=1 AND role='admin')`;
const kioskAuthority = `EXISTS(SELECT 1 FROM kiosks k WHERE k.installation_id='primary' AND k.id=? AND k.active=1 AND k.pairing_bound=1 AND k.pairing_code_id=? AND k.token_hash=?) AND ${fingerprintResetGuard}`;
const shareableTemplate = `NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_retirements r WHERE r.installation_id=t.installation_id AND r.vault_id=t.vault_id AND r.fingerprint_id=t.fingerprint_id) AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_retired_review_grants r WHERE r.installation_id=t.installation_id AND r.grant_id=t.enrollment_id)`;

/** Durable server-decryptable vault boundary. Templates are kiosk-only responses,
 * never dashboard data. Authentication and maintenance gates belong at composition.
 * Every database operation also checks current module, member and actor authority.
 */
export async function fingerprintVaultRoute(request: Request, context: Context): Promise<Response> {
  const { db, actor, readJson, respond, secret } = context;
  const url = new URL(request.url), path = url.pathname;
  const queryFields: string[] = []; url.searchParams.forEach((_value, key) => queryFields.push(key));
  if (actor.kind === "admin") {
    const retirement = /^\/admin\/kiosks\/fingerprint-vault\/enrollments\/([a-f0-9]{64})$/.exec(path);
    if (path === "/admin/kiosks/fingerprint-vault/enrollments" && request.method === "GET") {
      const after = url.searchParams.get("after") ?? "";
      if (after && !hexId(after) || queryFields.some(field => field !== "after") || queryFields.length > 1) throw new HttpError(400, "Invalid enrollment cursor");
      const rows = await db.prepare(`SELECT t.fingerprint_id AS fingerprintId,t.vault_id AS vaultId,t.member_id AS rosterId,m.external_id AS memberId,
        m.first_name AS firstName,m.last_name AS lastName,t.created_at AS createdAt
        FROM kiosk_fingerprint_vault_templates t JOIN members m ON m.id=t.member_id AND m.installation_id=t.installation_id
        WHERE t.installation_id='primary' AND t.fingerprint_id>? AND ${shareableTemplate} AND ${adminAuthority} AND ${attendanceAuthority}
        ORDER BY t.fingerprint_id LIMIT 50`).bind(after, actor.userId).all();
      return respond({ enrollments: rows.results ?? [] });
    }
    if (retirement && request.method === "DELETE") {
      const input = await readJson(request, 1024);
      if (!exact(input, ["vaultId", "rosterId", "confirmation"]) || !hexId(input.vaultId) || !identifier(input.rosterId) || input.confirmation !== "RETIRE ENROLLMENT EVERYWHERE") throw new HttpError(400, "Confirm enrollment retirement everywhere");
      const authority = `${adminAuthority} AND ${attendanceAuthority} AND EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_settings WHERE installation_id='primary' AND vault_id=? AND enabled=1)`;
      const args = [retirement[1], input.vaultId, input.rosterId, actor.userId, input.vaultId];
      await db.batch([
        // Preserve source retry suppression even after ciphertext is deleted.
        db.prepare(`INSERT INTO kiosk_fingerprint_vault_enrollments(installation_id,vault_id,source_kiosk_id,source_pairing_id,enrollment_id,member_id,fingerprint_id)
          SELECT installation_id,vault_id,source_kiosk_id,source_pairing_id,enrollment_id,member_id,fingerprint_id FROM kiosk_fingerprint_vault_templates
          WHERE installation_id='primary' AND fingerprint_id=? AND vault_id=? AND member_id=? AND ${authority}
          ON CONFLICT(installation_id,vault_id,source_kiosk_id,source_pairing_id,enrollment_id) DO NOTHING`).bind(...args),
        db.prepare(`INSERT INTO kiosk_fingerprint_vault_retirements(installation_id,vault_id,fingerprint_id,member_id,retired_at)
          SELECT installation_id,vault_id,fingerprint_id,member_id,? FROM kiosk_fingerprint_vault_templates
          WHERE installation_id='primary' AND fingerprint_id=? AND vault_id=? AND member_id=? AND ${authority}
          ON CONFLICT DO NOTHING`).bind(Date.now(), ...args),
        db.prepare(`DELETE FROM kiosk_fingerprint_vault_templates WHERE installation_id='primary' AND fingerprint_id=? AND vault_id=? AND member_id=? AND ${authority}
          AND EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_retirements r WHERE r.fingerprint_id=kiosk_fingerprint_vault_templates.fingerprint_id AND r.vault_id=kiosk_fingerprint_vault_templates.vault_id)`).bind(...args),
        db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
          SELECT ?,'primary',?,'kiosk.fingerprint_enrollment_retired','fingerprint_enrollment',?,'{}',? WHERE changes()>0`)
          .bind(crypto.randomUUID(), actor.userId, retirement[1], new Date().toISOString()),
      ]);
      const retired = await db.prepare(`SELECT 1 FROM kiosk_fingerprint_vault_retirements WHERE installation_id='primary' AND fingerprint_id=? AND vault_id=? AND member_id=? AND ${authority}`).bind(...args).first();
      if (!retired) throw new HttpError(409, "Enrollment or administrator authority changed");
      return respond({ retired: true, readerTemplatesRetained: true });
    }
    if (path !== "/admin/kiosks/fingerprint-vault") throw new HttpError(404, "Not found");
    if (request.method === "PATCH") {
      const input = await readJson(request, 1024);
      if (!exact(input, ["enabled", "confirmation"]) || typeof input.enabled !== "boolean" || input.confirmation !== (input.enabled ? "ENABLE CLOUD FINGERPRINT STORAGE" : "DISABLE CLOUD FINGERPRINT STORAGE")) throw new HttpError(400, "Confirm the fingerprint cloud-storage privacy change");
      const keyId = input.enabled ? await fingerprintVaultKeyId(secret) : null;
      const previous = await db.prepare("SELECT vault_id AS vaultId,key_id AS keyId,enabled,catalog_revision AS catalogRevision FROM kiosk_fingerprint_vault_settings WHERE installation_id='primary'").first<Settings>();
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
    const settings = await db.prepare(`SELECT vault_id AS vaultId,key_id AS keyId,enabled,catalog_revision AS catalogRevision FROM kiosk_fingerprint_vault_settings
      WHERE installation_id='primary' AND ${adminAuthority} AND ${attendanceAuthority}`).bind(actor.userId).first<Settings>();
    let keyStatus = "missing";
    try { const id = await fingerprintVaultKeyId(secret); keyStatus = settings?.enabled && settings.keyId !== id ? "changed" : "ready"; } catch { /* Never disclose secret values or parser diagnostics. */ }
    const count = await db.prepare(`SELECT count(*) AS total FROM kiosk_fingerprint_vault_templates t WHERE t.installation_id='primary' AND ${shareableTemplate} AND ${adminAuthority} AND ${attendanceAuthority}`).bind(actor.userId).first<{ total: number }>();
    return respond({ enabled: Boolean(settings?.enabled), keyStatus, storedFingerprints: count?.total ?? 0, serverManagedKeys: true });
  }
  if (!actor.pairingBound) throw new HttpError(409, "Re-pair this kiosk before using fingerprint cloud storage");
  const authorityBindings = [actor.id, actor.pairingId, actor.credentialHash, actor.id, actor.pairingId];
  const settings = await db.prepare(`SELECT vault_id AS vaultId,key_id AS keyId,enabled,catalog_revision AS catalogRevision FROM kiosk_fingerprint_vault_settings
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
      // The source tuple identifies an enrollment. A reader may change its bytes
      // after recognition; a retry must never create a second enrollment.
      binding.fingerprintId = await fingerprintVaultEnrollmentId(binding);
      const encrypted = await sealFingerprintVault(template, binding, secret!);
      const tuple = [settings.vaultId, actor.id, actor.pairingId, input.enrollmentId];
      const receiptWhere = "installation_id='primary' AND vault_id=? AND source_kiosk_id=? AND source_pairing_id=? AND enrollment_id=?";
      try {
        await db.batch([
          db.prepare(`INSERT INTO kiosk_fingerprint_vault_templates(fingerprint_id,installation_id,vault_id,member_id,template_digest,ciphertext,nonce,format,source_kiosk_id,source_pairing_id,enrollment_id,created_at)
            SELECT ?,'primary',?,?,?,?,?,?,?,?,?,? WHERE ${sourceAuthority}
            AND EXISTS(SELECT 1 FROM members WHERE installation_id='primary' AND id=? AND external_id=? AND active=1)
            AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_enrollments WHERE ${receiptWhere})
            AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_templates WHERE ${receiptWhere})
            AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_templates WHERE installation_id='primary' AND vault_id=? AND template_digest=?)`)
            .bind(binding.fingerprintId, settings.vaultId, member.id, templateDigest, encrypted.ciphertext, encrypted.nonce, fingerprintVaultFormat, actor.id, actor.pairingId, input.enrollmentId, binding.createdAt,
              ...sourceBindings, member.id, input.memberId, ...tuple, ...tuple, settings.vaultId, templateDigest),
          // Preserve old rows. The first historical copy becomes this source's
          // receipt only when every historical source binding agrees on member.
          db.prepare(`INSERT INTO kiosk_fingerprint_vault_enrollments(installation_id,vault_id,source_kiosk_id,source_pairing_id,enrollment_id,member_id,fingerprint_id)
            SELECT 'primary',?,?,?,?,?,t.fingerprint_id FROM kiosk_fingerprint_vault_templates t
            WHERE t.installation_id='primary' AND t.vault_id=? AND t.member_id=? AND ${shareableTemplate} AND ${sourceAuthority}
            AND EXISTS(SELECT 1 FROM members WHERE installation_id='primary' AND id=? AND external_id=? AND active=1)
            AND ((t.source_kiosk_id=? AND t.source_pairing_id=? AND t.enrollment_id=?) OR t.template_digest=?)
            AND NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_vault_templates WHERE ${receiptWhere} AND member_id<>?)
            ORDER BY CASE WHEN t.source_kiosk_id=? AND t.source_pairing_id=? AND t.enrollment_id=? THEN 0 ELSE 1 END,t.created_at,t.fingerprint_id LIMIT 1
            ON CONFLICT(installation_id,vault_id,source_kiosk_id,source_pairing_id,enrollment_id) DO NOTHING`)
            .bind(...tuple, member.id, settings.vaultId, member.id, ...sourceBindings, member.id, input.memberId,
              actor.id, actor.pairingId, input.enrollmentId, templateDigest, ...tuple, member.id, actor.id, actor.pairingId, input.enrollmentId),
        ]);
      } catch { throw new HttpError(409, "Fingerprint cloud storage authority or capacity changed"); }
      const saved = await db.prepare(`SELECT e.fingerprint_id AS fingerprintId,t.template_digest AS templateDigest FROM kiosk_fingerprint_vault_enrollments e
        JOIN kiosk_fingerprint_vault_templates t ON t.fingerprint_id=e.fingerprint_id AND t.member_id=e.member_id
        WHERE e.installation_id='primary' AND e.vault_id=? AND e.source_kiosk_id=? AND e.source_pairing_id=? AND e.enrollment_id=? AND e.member_id=? AND ${shareableTemplate} AND ${sourceAuthority}
        AND EXISTS(SELECT 1 FROM members WHERE installation_id='primary' AND id=? AND external_id=? AND active=1)`)
        .bind(...tuple, member.id, ...sourceBindings, member.id, input.memberId).first<{ fingerprintId: string; templateDigest: string }>();
      if (!saved) throw new HttpError(409, "Fingerprint enrollment is retired or its member binding requires review");
      return respond({ stored: true, fingerprintId: saved.fingerprintId, templateMatches: saved.templateDigest === templateDigest }, 200);
    } finally { template.fill(0); }
  }
  if (["/kiosk/fingerprint-vault/templates", "/kiosk/fingerprint-vault/catalog"].includes(path) && request.method === "GET") {
    const full = path.endsWith("/catalog");
    if (full && (queryFields.length !== 1 || queryFields[0] !== "revision" || url.searchParams.get("revision") !== String(settings.catalogRevision))) throw new HttpError(409, "Fingerprint catalog revision changed");
    const afters = url.searchParams.getAll("after"), after = afters[0] ?? "";
    if (afters.length > 1 || afters.length && !hexId(after) || queryFields.some(key => key !== (full ? "revision" : "after"))) throw new HttpError(400, "Invalid fingerprint vault cursor");
    // Merge two indexed cursor scans, sharing one current-authority check.
    const rows = await db.prepare(`WITH authority AS MATERIALIZED (SELECT 1 WHERE ${currentAuthority})
      SELECT t.fingerprint_id AS fingerprintId,m.external_id AS memberId,m.id AS rosterId,0 AS retired,'[]' AS sourceEnrollmentIds
      FROM kiosk_fingerprint_vault_templates t CROSS JOIN members m ON m.id=t.member_id AND m.installation_id=t.installation_id AND m.active=1
      CROSS JOIN authority
      WHERE t.installation_id='primary' AND t.vault_id=? AND t.fingerprint_id>? AND ${shareableTemplate}
      UNION ALL
      SELECT t.fingerprint_id AS fingerprintId,m.external_id AS memberId,m.id AS rosterId,1 AS retired,
        (SELECT json_group_array(e.enrollment_id) FROM kiosk_fingerprint_vault_enrollments e
          WHERE e.installation_id=t.installation_id AND e.vault_id=t.vault_id AND e.fingerprint_id=t.fingerprint_id AND e.member_id=t.member_id AND e.source_kiosk_id=? AND e.source_pairing_id=?) AS sourceEnrollmentIds
      FROM kiosk_fingerprint_vault_retirements t CROSS JOIN members m ON m.id=t.member_id AND m.installation_id=t.installation_id AND m.active=1
      CROSS JOIN authority
      WHERE t.installation_id='primary' AND t.vault_id=? AND t.fingerprint_id>?
      ORDER BY fingerprintId LIMIT ${full ? 10001 : 8}`)
      .bind(...currentBindings, settings.vaultId, after, actor.id, actor.pairingId, settings.vaultId, after).all<{ fingerprintId: string; memberId: string; rosterId: string; retired: number; sourceEnrollmentIds: string }>();
    if (full) {
      const current = await db.prepare(`SELECT catalog_revision AS revision FROM kiosk_fingerprint_vault_settings WHERE installation_id='primary' AND ${currentAuthority}`).bind(...currentBindings).first<{ revision: number }>();
      if (!current || current.revision !== settings.catalogRevision) throw new HttpError(409, "Fingerprint catalog revision changed");
      if ((rows.results ?? []).length > 10000) throw new HttpError(409, "Fingerprint catalog exceeds supported capacity");
    }
    return respond({ vaultId: settings.vaultId, ...(full ? { catalogRevision: settings.catalogRevision } : {}), fingerprints: (rows.results ?? []).map(({ retired, sourceEnrollmentIds, ...row }) => ({ ...row, ...(retired ? { retired: true, sourceEnrollmentIds: JSON.parse(sourceEnrollmentIds) } : {}) })) });
  }
  const download = async (fingerprintId: string) => {
    const record = await db.prepare(`SELECT t.fingerprint_id AS fingerprintId,t.member_id AS memberId,m.external_id AS externalId,t.template_digest AS templateDigest,t.ciphertext,t.nonce,
      t.source_kiosk_id AS sourceKioskId,t.source_pairing_id AS sourcePairingId,t.enrollment_id AS enrollmentId,t.created_at AS createdAt FROM kiosk_fingerprint_vault_templates t
      JOIN members m ON m.id=t.member_id AND m.installation_id=t.installation_id AND m.active=1
      WHERE t.installation_id='primary' AND t.vault_id=? AND t.fingerprint_id=? AND ${shareableTemplate} AND ${currentAuthority}`)
      .bind(settings.vaultId, fingerprintId, ...currentBindings).first<{ fingerprintId: string; memberId: string; externalId: string; templateDigest: string; ciphertext: string; nonce: string; sourceKioskId: string; sourcePairingId: string; enrollmentId: string; createdAt: number }>();
    if (!record) throw new HttpError(404, "Fingerprint cloud enrollment not found");
    const template = await openFingerprintVault(record, { ...record, vaultId: settings.vaultId, keyId: settings.keyId }, secret!);
    try {
      // Recheck after decryption so a concurrent retirement, key/configuration
      // change or member revocation cannot release data authorized by an old read.
      const valid = await db.prepare(`SELECT 1 AS valid FROM kiosk_fingerprint_vault_templates t JOIN members m ON m.id=t.member_id AND m.active=1 AND m.installation_id=t.installation_id
        WHERE t.installation_id='primary' AND t.vault_id=? AND t.fingerprint_id=? AND m.external_id=? AND ${shareableTemplate} AND ${currentAuthority}`)
        .bind(settings.vaultId, record.fingerprintId, record.externalId, ...currentBindings).first();
      if (!valid) throw new HttpError(409, "Fingerprint cloud enrollment authority changed");
      return { vaultId: settings.vaultId, fingerprintId: record.fingerprintId, memberId: record.externalId, rosterId: record.memberId, format: fingerprintVaultFormat, template: fingerprintVaultBase64(template) };
    } finally { template.fill(0); }
  }
  if (path === "/kiosk/fingerprint-vault/batch" && request.method === "POST") {
    const input = await readJson(request, 2048);
    if (queryFields.length || !exact(input, ["vaultId", "catalogRevision", "fingerprintIds"]) || input.vaultId !== settings.vaultId || input.catalogRevision !== settings.catalogRevision || !Array.isArray(input.fingerprintIds) || input.fingerprintIds.length < 1 || input.fingerprintIds.length > 8 || input.fingerprintIds.some(value => !hexId(value)) || new Set(input.fingerprintIds).size !== input.fingerprintIds.length) throw new HttpError(409, "Invalid or stale fingerprint batch");
    const templates = [];
    try {
      for (const fingerprintId of input.fingerprintIds as string[]) templates.push(await download(fingerprintId));
      // All plaintext is withheld if authority or any catalog item changes while
      // decrypting the batch. No partial response can be mistaken for completion.
      const current = await db.prepare(`SELECT catalog_revision AS revision FROM kiosk_fingerprint_vault_settings WHERE installation_id='primary' AND ${currentAuthority}`).bind(...currentBindings).first<{ revision: number }>();
      if (!current || current.revision !== input.catalogRevision) throw new HttpError(409, "Fingerprint batch authority changed");
      return respond({ vaultId: settings.vaultId, catalogRevision: current.revision, templates });
    } finally { for (const template of templates) template.template = ""; }
  }
  const item = /^\/kiosk\/fingerprint-vault\/templates\/([a-f0-9]{64})$/.exec(path);
  if (item && request.method === "GET") {
    if (queryFields.length) throw new HttpError(400, "Invalid fingerprint vault request");
    return respond(await download(item[1]));
  }
  throw new HttpError(404, "Not found");
}
