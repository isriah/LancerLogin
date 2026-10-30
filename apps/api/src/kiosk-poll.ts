import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";
import { readKioskEnrollment } from "./kiosk-enrollment.ts";
import { fingerprintVaultFormat, fingerprintVaultKeyId } from "./fingerprint-vault-crypto.ts";

type Context = { db: D1Database; credentialHash: string; secret?: string; respond(value: unknown, status?: number): Response };
type Row = { id: string; name: string; pairingBound: number; command: string | null; configuration?: string | null;
  reset?: string | null; rosterRevision?: number; members?: string | null; vaultEnabled?: number | null; vaultId?: string | null; keyId?: string | null; catalogRevision?: number | null; maintenance?: number };

/** One current-authority transaction replaces independent background reads.
 * The caller supplies the Attendance-scoped database, whose before/after guards
 * retain module generation and administration epoch checks in this transaction.
 * The authenticated kiosk CTE gates every result, including conditional replies.
 * This snapshot is metadata only; transfer routes independently check authority.
 */
export async function kioskPoll(request: Request, { db, credentialHash, secret, respond }: Context): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const fields = new Set(["v", "fingerprints", "config", "rosterRevision", "peerAfter", "enrollment"]);
  let invalidQuery = false;
  query.forEach((_value, key) => { if (!fields.has(key) || query.getAll(key).length !== 1) invalidQuery = true; });
  if (invalidQuery || query.get("v") !== "1") throw new HttpError(400, "Unsupported kiosk poll request");
  for (const flag of ["fingerprints", "config", "enrollment"]) if (query.has(flag) && query.get(flag) !== "1") throw new HttpError(400, "Invalid kiosk poll section");
  const fingerprints = query.has("fingerprints"), configuration = query.has("config");
  const revisionText = query.get("rosterRevision"), after = query.get("peerAfter") ?? "";
  if (revisionText !== null && (!/^\d{1,16}$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) || after && !/^[A-Za-z0-9._:-]{1,128}$/.test(after)) throw new HttpError(400, "Invalid kiosk poll revision or cursor");
  if (!fingerprints && (revisionText !== null || query.has("peerAfter"))) throw new HttpError(400, "Fingerprint state requires the fingerprint section");
  const bindings: unknown[] = [credentialHash, new Date(Date.now() - 15 * 60_000).toISOString()];
  if (fingerprints) bindings.push(revisionText === null ? -1 : Number(revisionText));
  const row = await db.prepare(`WITH current_kiosk AS MATERIALIZED (
      SELECT id,name,pairing_code_id AS pairingId,pairing_bound AS pairingBound,configured_authentication_method AS authenticationMethod FROM kiosks
      WHERE installation_id='primary' AND token_hash=? AND active=1
    )${fingerprints ? `, maintenance_lock AS MATERIALIZED (
      SELECT 1 FROM web_update_requests WHERE installation_id='primary' AND maintenance=1 LIMIT 1
    ), fingerprint_kiosk AS MATERIALIZED (
      SELECT * FROM current_kiosk WHERE pairingBound=1 AND NOT EXISTS(SELECT 1 FROM maintenance_lock)
    ), pending_reset AS MATERIALIZED (
      SELECT r.id,r.created_at AS createdAt FROM kiosk_fingerprint_reset_commands r,fingerprint_kiosk k
      WHERE r.installation_id='primary' AND r.kiosk_id=k.id AND r.pairing_id=k.pairingId AND r.acknowledged_at IS NULL
      ORDER BY r.created_at,r.id LIMIT 1
    ), sharing_kiosk AS MATERIALIZED (
      SELECT * FROM fingerprint_kiosk WHERE NOT EXISTS(SELECT 1 FROM pending_reset)
    )` : ""}
    SELECT k.id,k.name,k.pairingBound,
      (SELECT json_object('id',c.id,'type',c.command_type,'createdAt',c.created_at,'targetTag',c.requested_release_version,
        'targetCommit',c.requested_release_sha,'channel',c.update_channel) FROM kiosk_commands c
        WHERE c.installation_id='primary' AND c.kiosk_id=k.id AND c.completed_at IS NULL AND c.created_at>=? ORDER BY c.created_at LIMIT 1) AS command
      ${configuration ? `,(SELECT json_object('organizationName',organization_name,'subtitle',subtitle,'logoData',logo_data,
        'primaryColor',primary_color,'secondaryColor',secondary_color,'logoBackdrop',logo_backdrop,'authenticationMethod',k.authenticationMethod,
        'fingerprintMinimumScore',COALESCE((SELECT minimum_score FROM kiosk_fingerprint_match_settings WHERE installation_id='primary'),0),
        'fingerprintReenrollScore',COALESCE((SELECT CASE WHEN minimum_score>0 THEN minimum_score+20 END FROM kiosk_fingerprint_match_settings WHERE installation_id='primary'),70))
        FROM organization_settings WHERE installation_id='primary') AS configuration` : ""}
      ${fingerprints ? `,EXISTS(SELECT 1 FROM maintenance_lock) AS maintenance,
      (SELECT json_object('id',id,'createdAt',createdAt,'kind','reset_fingerprint_mappings') FROM pending_reset) AS reset,
      (SELECT revision FROM kiosk_roster_revision WHERE installation_id='primary') AS rosterRevision,
      CASE WHEN (SELECT revision FROM kiosk_roster_revision WHERE installation_id='primary')<>? AND k.pairingBound=1 THEN
        (SELECT json_group_array(json_object('rosterId',id,'memberId',external_id,'firstName',first_name,'lastName',last_name))
          FROM (SELECT id,external_id,first_name,last_name FROM members WHERE installation_id='primary' AND active=1 ORDER BY last_name,first_name LIMIT 10001)) END AS members,
      (SELECT v.enabled FROM kiosk_fingerprint_vault_settings v,sharing_kiosk me WHERE v.installation_id='primary') AS vaultEnabled,
      (SELECT v.vault_id FROM kiosk_fingerprint_vault_settings v,sharing_kiosk me WHERE v.installation_id='primary') AS vaultId,
      (SELECT v.key_id FROM kiosk_fingerprint_vault_settings v,sharing_kiosk me WHERE v.installation_id='primary') AS keyId,
      (SELECT v.catalog_revision FROM kiosk_fingerprint_vault_settings v,sharing_kiosk me WHERE v.installation_id='primary') AS catalogRevision` : ""}
      FROM current_kiosk k`).bind(...bindings).first<Row>();
  if (!row) throw new HttpError(401, "Kiosk credential is invalid");
  const result: Record<string, unknown> = { protocol: 1, command: row.command ? JSON.parse(row.command) : null };
  if (query.has("enrollment")) result.enrollment = await readKioskEnrollment(db, row.id);
  if (configuration) result.configuration = { kiosk: { id: row.id, name: row.name }, settings: row.configuration ? JSON.parse(row.configuration) : null };
  if (fingerprints) {
    const bound = Boolean(row.pairingBound), reset = row.reset ? JSON.parse(row.reset) : null;
    const revisionValid = Number.isSafeInteger(row.rosterRevision) && row.rosterRevision! >= 0;
    const members = row.members ? JSON.parse(row.members) as unknown[] : undefined;
    const roster = bound && revisionValid && (!members || members.length <= 10000)
      ? { status: "ok", revision: row.rosterRevision, notModified: members === undefined, ...(members ? { members } : {}) }
      : { status: "unavailable" };
    const status = !bound || row.maintenance ? "unavailable" : reset ? "reset_pending" : "ok";
    let vault: Record<string, unknown> = { status, enabled: false, vaultId: null, catalogRevision: null };
    if (status === "ok" && row.vaultEnabled) {
      try {
        if (await fingerprintVaultKeyId(secret) !== row.keyId || !Number.isSafeInteger(row.catalogRevision) || row.catalogRevision! < 0) throw new Error("Unavailable vault authority");
        vault = { status: "ok", enabled: true, vaultId: row.vaultId, format: fingerprintVaultFormat, catalogRevision: row.catalogRevision };
      } catch { vault = { status: "unavailable", enabled: false, vaultId: null, catalogRevision: null }; }
    }
    const peer = { status, enabled: false, syncId: null, deliveries: [] };
    result.fingerprints = {
      reset: { status: bound && !row.maintenance ? "ok" : "unavailable", commands: bound && !row.maintenance && reset ? [reset] : [] },
      roster,
      peer,
      vault,
    };
  }
  const reply = respond(result);
  reply.headers.set("Cache-Control", "no-store"); reply.headers.set("Pragma", "no-cache");
  return reply;
}
