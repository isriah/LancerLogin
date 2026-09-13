import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryFixture } from './fixtures/updater-recovery-fixture.mjs';
async function authenticated(f) {
  const response = await f.service.fetch(new Request(f.origin + '/recovery/session', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ credential: f.credential }) }));
  assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /__Host-lancerlogin_recovery=/); assert.match(cookie, /Secure; HttpOnly; SameSite=Strict; Max-Age=900/);
  const sessionCookie = cookie.split(';')[0];
  const status = await (await f.service.fetch(new Request(f.origin + '/recovery/status', { headers: { cookie: sessionCookie } }))).json();
  return { cookie: sessionCookie, csrf: status.csrfToken };
}
function action(f, auth, name, body = {}, nonce = crypto.randomUUID()) {
  return new Request(f.origin + '/recovery/' + name, { method: 'POST', headers: { origin: f.origin, cookie: auth.cookie, 'content-type': 'application/json', 'x-recovery-csrf': auth.csrf, 'x-recovery-nonce': nonce }, body: JSON.stringify(body) });
}
test('independent recovery restores captured code through actual engine while app and release source are unavailable', async t => {
  const f = await recoveryFixture(); t.after(f.close); const auth = await authenticated(f);
  const body = { requestId: crypto.randomUUID(), failedJobId: f.failedJobId, mode: 'code-recovery', confirmation: 'RECOVER APPLICATION CODE' };
  const first = action(f, auth, 'recovery', body), replay = first.clone();
  let status = await (await f.service.fetch(first)).json(); const jobId = status.job.id;
  assert.equal(status.job.requestId, body.requestId); assert.equal(status.recoveryRequest.state, 'accepted');
  assert.equal((await f.service.fetch(replay)).status, 409);
  const retry = await (await f.service.fetch(action(f, auth, 'recovery', body))).json(); assert.equal(retry.job.id, jobId);
  const reads = f.statusReads();
  for (let count = 0; count < 10 && status.job.status === 'running'; count++) status = await (await f.service.fetch(action(f, auth, 'advance', { jobId }))).json();
  assert.equal(f.statusReads(), reads, 'recovery advance does not reread engine status');
  assert.equal(status.job.status, 'recovered'); assert.equal(status.installedVersion, '1.0.0'); assert.equal(status.highestSequence, 2); assert.equal(f.sourceCalls(), 0);
  assert.ok(!JSON.stringify(status).includes(f.credential));
  const rows = f.db.prepare('SELECT * FROM updater_recovery_sessions').all(); assert.ok(!JSON.stringify(rows).includes(auth.cookie.split('=')[1]));
});
test('sessions enforce origin, CSRF, exact bodies, expiry and separate credentials; unavailable restoration is definite rejection', async t => {
  const f = await recoveryFixture(); t.after(f.close); const auth = await authenticated(f);
  const wrongOrigin = action(f, auth, 'advance', { jobId: f.failedJobId }); wrongOrigin.headers.set('origin', 'https://app.example.invalid'); assert.equal((await f.service.fetch(wrongOrigin)).status, 403);
  const wrongCsrf = action(f, auth, 'advance', { jobId: f.failedJobId }); wrongCsrf.headers.set('x-recovery-csrf', '0'.repeat(64)); assert.equal((await f.service.fetch(wrongCsrf)).status, 403);
  assert.equal((await f.service.fetch(action(f, auth, 'recovery', { requestId: crypto.randomUUID(), failedJobId: f.failedJobId, mode: 'restore', confirmation: 'incorrect' }))).status, 409);
  const rejected = await (await f.service.fetch(action(f, auth, 'recovery', { requestId: crypto.randomUUID(), failedJobId: f.failedJobId, mode: 'restore', confirmation: 'RESTORE APPLICATION DATABASE' }))).json(); assert.equal(rejected.recoveryRequest.state, 'rejected');
  assert.equal((await f.service.fetch(action(f, auth, 'start', { releaseId: 2 }))).status, 404);
  assert.equal((await f.service.fetch(new Request(f.origin + '/recovery/status', { headers: { cookie: 'lancerlogin_session=synthetic-app-session' } }))).status, 401);
  assert.equal((await f.service.fetch(action(f, auth, 'advance', { jobId: f.failedJobId, untrusted: 'x'.repeat(4096) }))).status, 409);
  f.expire(); assert.equal((await f.service.fetch(new Request(f.origin + '/recovery/status', { headers: { cookie: auth.cookie } }))).status, 401);
});
test('credential login has bounded durable budget and page has no third-party or application dependencies', async t => {
  const f = await recoveryFixture(); t.after(f.close);
  for (let i = 0; i < 11; i++) { const response = await f.service.fetch(new Request(f.origin + '/recovery/session', { method: 'POST', headers: { origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ credential: '0'.repeat(64) }) })); assert.equal(response.status, i === 10 ? 429 : 401); }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM updater_recovery_login_budget').get().count, 1);
  const response = await f.service.fetch(new Request(f.origin + '/recovery'));
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await response.text(); assert.ok(!html.includes(f.credential)); assert.doesNotMatch(html, /src="https?:|href="https?:|\/admin\/|lancerlogin_session/);
});

test('concurrent retries resume only the same frozen pending recovery admission',async t=>{const f=await recoveryFixture();t.after(f.close);const auth=await authenticated(f),body={requestId:crypto.randomUUID(),failedJobId:f.failedJobId,mode:'code-recovery',confirmation:'RECOVER APPLICATION CODE'};f.db.prepare("INSERT INTO updater_recovery_requests(installation_id,request_id,failed_job_id,mode,state,created_at) VALUES(?,?,?,?,'pending',0)").run(f.installationId,body.requestId,body.failedJobId,body.mode);const before=f.db.prepare('SELECT total_changes() n').get().n;await f.service.fetch(new Request(f.origin+'/recovery/status',{headers:{cookie:auth.cookie}}));assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);const responses=await Promise.all([f.service.fetch(action(f,auth,'recovery',body)),f.service.fetch(action(f,auth,'recovery',body))]);for(const response of responses)assert.equal(response.status,200);const values=await Promise.all(responses.map(r=>r.json()));assert.equal(values[0].job.id,values[1].job.id);assert.equal(values[0].job.requestId,body.requestId);assert.equal((await f.service.fetch(action(f,auth,'recovery',{...body,mode:'restore',confirmation:'RESTORE APPLICATION DATABASE'}))).status,409);});
