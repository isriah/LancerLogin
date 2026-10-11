import type { D1Database } from "./d1-usage.ts";
import { HttpError } from "./http-error.ts";

type Actor = { kind: "admin"; userId: string } | { kind: "kiosk"; id: string; pairingId: string; pairingBound: boolean; credentialHash: string };
type Context = { db: D1Database; actor: Actor; readJson(request: Request, limit: number): Promise<unknown>; respond(value: unknown, status?: number): Response };
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)));
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const adminAuthority = `EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND active=1 AND role='admin')`;
const attendanceAuthority = `EXISTS(SELECT 1 FROM platform_modules WHERE installation_id='primary' AND module_id='attendance' AND phase='enabled')`;
const kioskAuthority = `EXISTS(SELECT 1 FROM kiosks WHERE installation_id='primary' AND id=? AND pairing_code_id=? AND token_hash=? AND active=1 AND pairing_bound=1)`;

// Bind the current kiosk and pairing in every template/relay read and write,
// including the atomic mutation predicate, not only at route entry.
export const fingerprintResetGuard = `NOT EXISTS(SELECT 1 FROM kiosk_fingerprint_reset_commands r WHERE r.installation_id='primary' AND r.kiosk_id=? AND r.pairing_id=? AND r.acknowledged_at IS NULL)`;

/** A mappings-only command never erases reader bytes, attendance or pairing.
 * Offline pairings remain blocked from sharing until durable acknowledgement.
 * No fingerprint identity review or legacy association authority is exposed.
 */
export async function fingerprintResetRoute(request: Request, context: Context): Promise<Response> {
  const { db, actor, readJson } = context;
  const url = new URL(request.url), path = url.pathname;
  if (url.searchParams.size) throw new HttpError(400, "Invalid fingerprint reset query");
  const respond = (value: unknown, status = 200) => {
    const result = context.respond(value, status);
    result.headers.set("Cache-Control", "no-store"); result.headers.set("Pragma", "no-cache"); return result;
  };
  if (actor.kind === "admin") {
    if (!await db.prepare(`SELECT 1 AS allowed WHERE ${adminAuthority} AND ${attendanceAuthority}`).bind(actor.userId).first()) throw new HttpError(403, "Administrator authority changed");
    if (path !== "/admin/kiosks/fingerprint-reset") throw new HttpError(404, "Not found");
    if (request.method === "GET") {
      const commands = await db.prepare(`SELECT r.id,r.batch_id AS batchId,r.kiosk_id AS kioskId,k.name AS kioskName,r.created_at AS createdAt,r.acknowledged_at AS acknowledgedAt,(k.active=1 AND k.pairing_bound=1 AND k.pairing_code_id=r.pairing_id) AS currentPairing FROM kiosk_fingerprint_reset_commands r JOIN kiosks k ON k.id=r.kiosk_id AND k.installation_id=r.installation_id WHERE r.installation_id='primary' AND r.batch_id=(SELECT id FROM kiosk_fingerprint_reset_batches WHERE installation_id='primary' ORDER BY created_at DESC,id DESC LIMIT 1) AND ${adminAuthority} AND ${attendanceAuthority} ORDER BY k.name,r.id LIMIT 32`).bind(actor.userId).all();
      return respond({ resetCommands: commands.results ?? [] });
    }
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
    const input = await readJson(request, 1024);
    if (!exact(input, ["resetId", "confirmation"]) || !identifier(input.resetId) || input.confirmation !== "RESET ALL FINGERPRINT MAPPINGS") throw new HttpError(400, "Type RESET ALL FINGERPRINT MAPPINGS to confirm. Reader templates will not be erased.");
    const pendingBatch = `EXISTS(SELECT 1 FROM kiosk_fingerprint_reset_batches b WHERE b.id=? AND b.installation_id='primary' AND b.actor_user_id=? AND b.processed_at IS NULL) AND ${adminAuthority} AND ${attendanceAuthority}`;
    const bindings = [input.resetId, actor.userId, actor.userId];
    await db.batch([
      db.prepare(`INSERT INTO kiosk_fingerprint_reset_batches(id,installation_id,actor_user_id,created_at) SELECT ?,'primary',?,? WHERE ${adminAuthority} AND ${attendanceAuthority} AND (SELECT count(*) FROM kiosks WHERE installation_id='primary' AND active=1 AND pairing_bound=1)<=32 AND (SELECT count(*) FROM kiosk_fingerprint_reset_batches WHERE installation_id='primary')<64 ON CONFLICT(id) DO NOTHING`).bind(input.resetId, actor.userId, Date.now(), actor.userId),
      db.prepare(`INSERT INTO kiosk_fingerprint_reset_commands(id,batch_id,installation_id,kiosk_id,pairing_id,created_at) SELECT lower(hex(randomblob(16))),?,'primary',k.id,k.pairing_code_id,? FROM kiosks k WHERE k.installation_id='primary' AND k.active=1 AND k.pairing_bound=1 AND ${pendingBatch}`).bind(input.resetId, Date.now(), ...bindings),
      db.prepare(`DELETE FROM kiosk_fingerprint_vault_settings WHERE installation_id='primary' AND ${pendingBatch}`).bind(...bindings),
      db.prepare(`UPDATE kiosk_fingerprint_sync SET enabled=0,sync_id=lower(hex(randomblob(32))) WHERE installation_id='primary' AND ${pendingBatch}`).bind(...bindings),
      db.prepare(`DELETE FROM kiosk_fingerprint_review_manifests WHERE installation_id='primary' AND ${pendingBatch}`).bind(...bindings),
      db.prepare(`DELETE FROM kiosk_fingerprint_review_requests WHERE installation_id='primary' AND ${pendingBatch}`).bind(...bindings),
      db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,'primary',?,'kiosk.fingerprint_mappings_reset_requested','fingerprint_reset',?,? ,? WHERE ${pendingBatch}`).bind(crypto.randomUUID(), actor.userId, input.resetId, JSON.stringify({ mappingsOnly: true, readerTemplatesErased: false }), new Date().toISOString(), ...bindings),
      db.prepare(`UPDATE kiosk_fingerprint_reset_batches SET processed_at=? WHERE id=? AND actor_user_id=? AND processed_at IS NULL AND ${adminAuthority} AND ${attendanceAuthority}`).bind(Date.now(), input.resetId, actor.userId, actor.userId),
    ]);
    const saved = await db.prepare(`SELECT id AS resetId,created_at AS createdAt,processed_at AS processedAt FROM kiosk_fingerprint_reset_batches WHERE installation_id='primary' AND id=? AND actor_user_id=? AND processed_at IS NOT NULL AND ${adminAuthority} AND ${attendanceAuthority}`).bind(input.resetId, actor.userId, actor.userId).first();
    if (!saved) throw new HttpError(409, "Fingerprint reset authority or capacity changed");
    return respond({ queued: true, ...saved, readerTemplatesErased: false });
  }
  if (!actor.pairingBound) throw new HttpError(409, "Re-pair this kiosk before resetting fingerprint mappings");
  const actorBindings = [actor.id, actor.pairingId, actor.credentialHash];
  if (!await db.prepare(`SELECT 1 AS allowed WHERE ${kioskAuthority} AND ${attendanceAuthority}`).bind(...actorBindings).first()) throw new HttpError(403, "Kiosk authority changed");
  if (path === "/kiosk/fingerprint-reset/commands" && request.method === "GET") {
    const reset = await db.prepare(`SELECT id,created_at AS createdAt FROM kiosk_fingerprint_reset_commands WHERE installation_id='primary' AND kiosk_id=? AND pairing_id=? AND acknowledged_at IS NULL AND ${kioskAuthority} AND ${attendanceAuthority} ORDER BY created_at,id LIMIT 1`).bind(actor.id, actor.pairingId, ...actorBindings).first();
    return respond({ commands: reset ? [{ ...reset, kind: "reset_fingerprint_mappings" }] : [] });
  }
  const commandPath = /^\/kiosk\/fingerprint-reset\/commands\/([A-Za-z0-9._:-]{1,128})\/acknowledge$/.exec(path);
  if (commandPath && request.method === "POST") {
    const input = await readJson(request, 512);
    if (!exact(input, ["completed"]) || input.completed !== true) throw new HttpError(400, "Confirm durable completion of the fingerprint reset");
    await db.prepare(`UPDATE kiosk_fingerprint_reset_commands SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=? AND installation_id='primary' AND kiosk_id=? AND pairing_id=? AND ${kioskAuthority} AND ${attendanceAuthority}`).bind(Date.now(), commandPath[1], actor.id, actor.pairingId, ...actorBindings).run();
    const saved = await db.prepare(`SELECT id FROM kiosk_fingerprint_reset_commands WHERE installation_id='primary' AND id=? AND kiosk_id=? AND pairing_id=? AND acknowledged_at IS NOT NULL AND ${kioskAuthority} AND ${attendanceAuthority}`).bind(commandPath[1], actor.id, actor.pairingId, ...actorBindings).first();
    if (!saved) throw new HttpError(409, "Fingerprint reset command authority changed");
    return respond({ acknowledged: true });
  }
  throw new HttpError(404, "Not found");
}
