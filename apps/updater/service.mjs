import { verifyUpdaterRequest } from '../../packages/shared/src/updater/service-auth.ts';
import { sha256 } from '../../packages/shared/src/updater/application-release.mjs';

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const check = (ok, code) => { if (!ok) throw new Error(code); };
// Trusted bootstrap injects the real engine/source/store and private capability.
// This app-authenticated surface is not the independent recovery login surface.
export function createUpdaterService({ engine, source, store, database, capability, installationId, appSecret, recoveryOrigin, controls, now = () => Date.now() }) {
  let recoveryUrl;
  if (recoveryOrigin !== undefined) { const url = new URL(recoveryOrigin); check(url.protocol === 'https:' && url.origin === recoveryOrigin && !url.username && !url.password, 'recovery-origin'); recoveryUrl = `${url.origin}/recovery`; }
  const readAvailability = async () => {
    const row = await database.prepare('SELECT revision, state_json, updated_at FROM updater_availability WHERE installation_id = ?').bind(installationId).first();
    return row ? { revision: row.revision, value: JSON.parse(row.state_json), updatedAt: row.updated_at } : { revision: -1, value: { status: 'not-checked' }, updatedAt: 0 };
  };
  async function saveAvailability(row, value) {
    const serialized = JSON.stringify(value); check(new TextEncoder().encode(serialized).length <= 131072, 'availability-size');
    if (row.revision < 0) return Boolean(await database.prepare('INSERT INTO updater_availability(installation_id, revision, state_json, updated_at) VALUES (?, 0, ?, ?) ON CONFLICT DO NOTHING RETURNING revision').bind(installationId, serialized, now()).first());
    return Boolean(await database.prepare('UPDATE updater_availability SET revision = revision + 1, state_json = ?, updated_at = ? WHERE installation_id = ? AND revision = ? RETURNING revision').bind(serialized, now(), installationId, row.revision).first());
  }
  const installedDigest = state => sha256(new TextEncoder().encode(JSON.stringify(state.installed)));
  async function status(requestId = null, completedStatus = null) {
    const state = completedStatus ?? await engine.status(capability), installed = await store.read(), row = await readAvailability();
    const value = row.value.installedDigest === await installedDigest(installed.state) ? row.value : { status: 'not-checked' };
    const availability = { status: value.status, checkedAt: row.updatedAt, checked: value.checked ?? 0, total: value.total ?? 0 };
    if (value.status === 'available') { availability.version = value.version; availability.releaseId = value.identity.releaseId; }
    check((state.job?.id ?? null) === (installed.state.job?.id ?? null), 'state-conflict');
    if (state.job) state.job.requestId = installed.state.job.requestId;
    const admission = requestId ? await database.prepare('SELECT request_id, state, reason FROM updater_admissions WHERE installation_id = ? AND request_id = ?').bind(installationId, requestId).first() : await database.prepare('SELECT request_id, state, reason FROM updater_admissions WHERE installation_id = ? ORDER BY created_at DESC, request_id DESC LIMIT 1').bind(installationId).first();
    return { configured: true, ...state, ...(recoveryUrl ? { recoveryUrl, ...(controls ? { controlUrl: recoveryUrl.replace('/recovery','/control') } : {}) } : {}), availability, admission: admission ? { requestId: admission.request_id, state: admission.state, reason: admission.reason } : null };
  }
  async function checkAvailability() {
    const state = await store.read(); check(state, 'not-initialized');
    if (state.state.job && !['succeeded', 'recovered'].includes(state.state.job.status)) return status();
    const row = await readAvailability(), digest = await installedDigest(state.state);
    let value;
    try { value = await source.available(state.state.installed, row.value.installedDigest === digest && row.value.status === 'checking' ? row.value.progress : null); }
    catch { value = { status: 'failed' }; }
    await saveAvailability(row, { ...value, installedDigest: digest }); return status();
  }
  async function start(body, actorId) {
    const claimed = controls ? await database.prepare("INSERT INTO updater_admissions(installation_id,request_id,release_id,state,created_at,actor_id) SELECT ?,?,?,'pending',?,? WHERE NOT EXISTS(SELECT 1 FROM updater_control_requests WHERE installation_id=? AND request_id=? AND (actor_id!=? OR release_id!=? OR session_hash IS NULL OR session_expires<=?)) ON CONFLICT DO NOTHING RETURNING request_id").bind(installationId,body.requestId,body.releaseId,now(),actorId,installationId,body.requestId,actorId,body.releaseId,Math.floor(now()/1000)).first() : await database.prepare("INSERT INTO updater_admissions(installation_id, request_id, release_id, state, created_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING RETURNING request_id").bind(installationId, body.requestId, body.releaseId, now()).first();
    const record = await database.prepare('SELECT release_id, state FROM updater_admissions WHERE installation_id = ? AND request_id = ?').bind(installationId, body.requestId).first();
    check(record && record.release_id === body.releaseId, 'request-conflict');
    if(controls){const actor=await database.prepare('SELECT actor_id FROM updater_admissions WHERE installation_id=? AND request_id=?').bind(installationId,body.requestId).first();check(actor.actor_id===actorId || actor.actor_id===null,'request-conflict');}
    const settle = async (state, reason = null) => database.prepare('UPDATE updater_admissions SET state = ?, reason = ? WHERE installation_id = ? AND request_id = ? AND state = ?').bind(state, reason, installationId, body.requestId, 'pending').run();
    const existing = await store.read();
    if (existing?.state.job?.requestId === body.requestId) { await settle('accepted'); return status(body.requestId); }
    if (!claimed) return status(body.requestId);
    let engineCalled = false;
    try {
      const selected = (await readAvailability()).value;
      check(selected.status === 'available' && selected.installedDigest === await installedDigest(existing.state) && selected.identity.releaseId === body.releaseId, 'release-unavailable');
      if(controls){const grant=await database.prepare('SELECT actor_id,release_identity FROM updater_control_requests WHERE installation_id=? AND request_id=?').bind(installationId,body.requestId).first();check(!grant||(grant.actor_id===actorId&&grant.release_identity===JSON.stringify(selected.identity)),'release-unavailable');}
      await source.resume(selected.identity);
      engineCalled = true;
      await engine.requestUpdate(capability, body);
      await settle('accepted');
    } catch (error) {
      const observed = await store.read();
      if (observed?.state.job?.requestId === body.requestId) await settle('accepted');
      else if (!engineCalled || ['maintenance-required', 'update-busy', 'state-conflict', 'downgrade', 'installed-compatibility', 'installed-ledger', 'updater-version'].includes(error?.message)) await settle('rejected', error?.message === 'maintenance-required' ? 'maintenance-required' : 'release-unavailable');
      // An unclassified admission failure remains pending; time is not evidence.
    }
    return status(body.requestId);
  }
  async function fetch(request) {
    let verified;
    try { verified = await verifyUpdaterRequest(request, appSecret, installationId, now()); }
    catch { return reply({ error: 'Updater request authentication failed.' }, 401); }
    try {
      await database.prepare('DELETE FROM updater_service_nonces WHERE expires_at < ?').bind(Math.floor(now() / 1000)).run();
      const claimed = await database.prepare('INSERT INTO updater_service_nonces(installation_id, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING nonce').bind(installationId, verified.nonce, verified.expiresAt).first();
      if (!claimed) return reply({ error: 'Updater request was already used.' }, 409);
      const { action, body } = verified;
      if(action==='control-grant'){check(controls,'updater-unavailable');const selected=(await readAvailability()).value,current=await store.read();check(selected.status==='available'&&selected.identity.releaseId===body.releaseId&&selected.installedDigest===await installedDigest(current.state),'release-unavailable');return reply(await controls.grant(verified.actorId,body,selected.identity));}
      if (action === 'check') return reply(await checkAvailability());
      if (action === 'start') {
        return reply(await start(body,verified.actorId));
      } else if (action === 'advance') return reply(await status(null, await engine.advance(capability, body.jobId)));
      else if (action === 'retry-preparation') await engine.retryPreparation(capability, body);
      else if (action === 'recovery') await engine.requestRecovery(capability, { requestId: body.requestId, failedJobId: body.failedJobId, mode: body.mode });
      return reply(await status());
    } catch (error) {
      const allowed = new Set(['not-initialized', 'release-unavailable', 'update-busy', 'state-conflict', 'request-conflict', 'maintenance-required', 'recovery-unavailable', 'restore-unavailable', 'preparation-retry-unavailable', 'job']);
      const code = allowed.has(error?.message) ? error.message : 'updater-unavailable';
      return reply({ error: code }, code === 'not-initialized' ? 503 : 409);
    }
  }
  return Object.freeze({ fetch, checkAvailability });
}
