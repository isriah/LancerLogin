import { sha256 } from '../../packages/shared/src/updater/application-release.mjs';
import { boundedUpdaterBytes, updaterAction } from '../../packages/shared/src/updater/service-auth.ts';
import { recoveryPage } from './recovery-ui.mjs';
const cookieName = '__Host-lancerlogin_recovery';
const encoder = new TextEncoder();
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const fixedHex = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let difference = 0; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i); return difference === 0; };
const check = (ok, code = 'request') => { if (!ok) throw new Error(code); };
const hashSession = (installationId, token) => sha256(encoder.encode(`LancerLogin recovery session v1\n${installationId}\n${token}`));
export async function recoveryCredentialDigest(credential, installationId) {
  check(fixedHex(credential), 'credential-format');
  return sha256(encoder.encode(`LancerLogin recovery credential v1\n${installationId}\n${credential}`));
}

// Bootstrap injects independent recovery trust, never the application's MAC key.
export function createRecoveryService({ engine, store, database, capability, installationId, origin, credentialSha256, now = () => Date.now() }) {
  check(typeof installationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(installationId) && fixedHex(credentialSha256), 'configuration');
  const location = new URL(origin); check(location.protocol === 'https:' && location.origin === origin, 'configuration');
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
  const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
  const expiredCookie = `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  async function session(request) {
    const tokens = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    check(tokens.length === 1, 'authentication'); const token = tokens[0].slice(cookieName.length + 1); check(fixedHex(token), 'authentication');
    const hash = await hashSession(installationId, token);
    const row = await database.prepare('SELECT csrf_token, expires_at FROM updater_recovery_sessions WHERE installation_id = ? AND session_hash = ? AND expires_at > ?').bind(installationId, hash, Math.floor(now() / 1000)).first();
    check(row, 'authentication'); return { hash, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }
  async function status(auth, requestId = null, completedStatus = null) {
    const value = completedStatus ?? await engine.status(capability), stored = await store.read();
    check((value.job?.id ?? null) === (stored?.state.job?.id ?? null), 'state-conflict');
    if (value.job) value.job.requestId = stored.state.job.requestId;
    const admission = requestId ? await database.prepare('SELECT request_id, state FROM updater_recovery_requests WHERE installation_id = ? AND request_id = ?').bind(installationId, requestId).first() : await database.prepare('SELECT request_id, state FROM updater_recovery_requests WHERE installation_id = ? ORDER BY created_at DESC, request_id DESC LIMIT 1').bind(installationId).first();
    return { ...value, csrfToken: auth.csrfToken, expiresAt: auth.expiresAt, recoveryRequest: admission ? { requestId: admission.request_id, state: admission.state } : null };
  }
  async function recover(auth, body) {
    const claimed = await database.prepare("INSERT INTO updater_recovery_requests(installation_id, request_id, failed_job_id, mode, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING RETURNING request_id").bind(installationId, body.requestId, body.failedJobId, body.mode, now()).first();
    const record = await database.prepare('SELECT failed_job_id, mode, state FROM updater_recovery_requests WHERE installation_id = ? AND request_id = ?').bind(installationId, body.requestId).first();
    check(record.failed_job_id === body.failedJobId && record.mode === body.mode, 'request-conflict');
    const settle = state => database.prepare('UPDATE updater_recovery_requests SET state = ? WHERE installation_id = ? AND request_id = ? AND state = ?').bind(state, installationId, body.requestId, 'pending').run();
    if ((await store.read())?.state.job?.requestId === body.requestId) { await settle('accepted'); return status(auth, body.requestId); }
    if (!claimed && record.state !== 'pending') return status(auth, body.requestId);
    try {
      await engine.requestRecovery(capability, { requestId: body.requestId, failedJobId: body.failedJobId, mode: body.mode });
      await settle('accepted');
    } catch (error) {
      if ((await store.read())?.state.job?.requestId === body.requestId) await settle('accepted');
      else if (['restore-required', 'restore-unavailable', 'recovery-unavailable', 'backup-unavailable', 'state-conflict'].includes(error?.message)) await settle('rejected');
    }
    return status(auth, body.requestId);
  }
  async function login(body) {
    const time = Math.floor(now() / 1000), window = time - time % 60;
    const budget = await database.prepare('INSERT INTO updater_recovery_login_budget(installation_id, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(installation_id) DO UPDATE SET window_start = excluded.window_start, attempts = CASE WHEN updater_recovery_login_budget.window_start = excluded.window_start THEN updater_recovery_login_budget.attempts + 1 ELSE 1 END RETURNING attempts').bind(installationId, window).first();
    if (budget.attempts > 10) return reply({ error: 'Recovery login temporarily limited. Try again later.' }, 429);
    check(body && Object.keys(body).length === 1 && fixedHex(body.credential), 'authentication');
    check(equal(await recoveryCredentialDigest(body.credential, installationId), credentialSha256), 'authentication');
    await database.prepare('DELETE FROM updater_recovery_sessions WHERE expires_at <= ?').bind(time).run();
    await database.prepare('DELETE FROM updater_recovery_nonces WHERE expires_at <= ?').bind(time).run();
    const token = random(), hash = await hashSession(installationId, token), csrfToken = random(), expiresAt = time + 900;
    await database.prepare('INSERT INTO updater_recovery_sessions(installation_id, session_hash, csrf_token, expires_at) VALUES (?, ?, ?, ?)').bind(installationId, hash, csrfToken, expiresAt).run();
    return reply({ authenticated: true }, 200, { 'set-cookie': `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900` });
  }
  async function fetch(request) {
    try {
      const url = new URL(request.url);
      check(url.origin === origin && !url.search && (!request.headers.has('origin') || request.headers.get('origin') === origin), 'origin');
      if (url.pathname === '/recovery' && request.method === 'GET') {
        const nonce = random();
        return new Response(recoveryPage(nonce), { headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` } });
      }
      check(request.headers.get('sec-fetch-site') !== 'cross-site', 'origin');
      const action = url.pathname.slice('/recovery/'.length);
      check(url.pathname.startsWith('/recovery/') && ['session', 'status', 'advance', 'retry-preparation', 'recovery', 'logout'].includes(action), 'route');
      check(request.method === (action === 'status' ? 'GET' : 'POST'), 'method');
      let body = {};
      if (request.method === 'POST') {
        check(request.headers.get('origin') === origin && request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'origin');
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedUpdaterBytes(request)));
      }
      if (action === 'session') return await login(body);
      const auth = await session(request);
      if (action === 'status') return reply(await status(auth));
      check(equal(request.headers.get('x-recovery-csrf'), auth.csrfToken), 'csrf');
      const nonce = request.headers.get('x-recovery-nonce');
      check(typeof nonce === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(nonce), 'nonce');
      if (action === 'logout') check(body && Object.keys(body).length === 0);
      else body = updaterAction(action, body);
      const claimed = await database.prepare('INSERT INTO updater_recovery_nonces(installation_id, session_hash, nonce, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING nonce').bind(installationId, auth.hash, nonce, auth.expiresAt).first();
      check(claimed, 'replay');
      if (action === 'logout') {
        await database.prepare('DELETE FROM updater_recovery_sessions WHERE installation_id = ? AND session_hash = ?').bind(installationId, auth.hash).run();
        return reply({ authenticated: false }, 200, { 'set-cookie': expiredCookie });
      }
      if (action === 'advance') return reply(await status(auth, null, await engine.advance(capability, body.jobId)));
      else if (action === 'retry-preparation') await engine.retryPreparation(capability, body);
      else return reply(await recover(auth, body));
      return reply(await status(auth));
    } catch (error) {
      if (error?.message === 'authentication') return reply({ error: 'Recovery authentication required.' }, 401, { 'set-cookie': expiredCookie });
      if (['origin', 'csrf'].includes(error?.message)) return reply({ error: 'Recovery request rejected.' }, 403);
      if (error?.message === 'route') return reply({ error: 'Not found.' }, 404);
      if (error?.message === 'method') return reply({ error: 'Method not allowed.' }, 405);
      return reply({ error: 'Recovery action could not complete. Refresh status before retrying.' }, 409);
    }
  }
  return Object.freeze({ fetch });
}
