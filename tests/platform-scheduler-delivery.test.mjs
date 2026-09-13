import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import worker, { PlatformScheduler } from '../apps/api/src/index.ts';
import { encryptIntegration } from '../apps/api/src/integration-crypto.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';
import { SchedulerBudget } from '../apps/api/src/scheduler-budget.ts';

test('admission counts before dispatch and leaves room under the Free subrequest ceiling', () => {
  const b = new SchedulerBudget(); for (let i = 0; i < 32; i++) b.query(); for (let i = 0; i < 12; i++) b.request();
  assert.throws(() => b.query()); assert.throws(() => b.request()); assert.equal(b.queries + b.requests, 44);
});

test('scheduled Discord channel passes skip inactive connections before credentials and preserve genuine failures', async () => {
  const raw = new DatabaseSync(':memory:'); const previousFetch = globalThis.fetch;
  const statements = []; let providerRequests = 0;
  try {
    for (const name of readdirSync(new URL('../apps/api/migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) raw.exec(readFileSync(new URL('../apps/api/migrations/' + name, import.meta.url), 'utf8'));
    raw.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'); INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','fixture','admin','2026-01-01'); INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');");
    const wrap = (sql, values = []) => ({ bind: (...args) => wrap(sql,args), first: async () => { statements.push(sql); return raw.prepare(sql).get(...values) ?? null; }, all: async () => { statements.push(sql); return {results:raw.prepare(sql).all(...values)}; }, run: async () => { statements.push(sql); return {meta:{changes:Number(raw.prepare(sql).run(...values).changes)}}; } });
    const db = {prepare:sql=>wrap(sql), batch:async rows=>{raw.exec('BEGIN');try{const results=[];for(const row of rows)results.push(await row.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}}};
    globalThis.fetch = async () => { providerRequests++; return Response.json({message:'synthetic provider failure'},{status:403}); };
    const secret='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const env={DB:db,APP_MODE:'configured',ALLOWED_ORIGIN:'https://fixture.invalid',SESSION_KEY:secret,PLATFORM_SCHEDULER_MODE:'durable'};
    let state={enabled:true,jobs:{'attendance.discord-channel':{next:0,last:null,outcome:'waiting'}}};
    const storage={transaction:async callback=>callback(),get:async()=>structuredClone(state),put:async(_,value)=>{state=structuredClone(value);},getAlarm:async()=>null,setAlarm:async()=>{},deleteAlarm:async()=>{}};
    const scheduler=new PlatformScheduler({storage},env);
    const pass=async()=>{state.jobs['attendance.discord-channel'].next=0;statements.length=0;await scheduler.alarm();return state.jobs['attendance.discord-channel'].outcome;};
    assert.equal(await pass(),'ok');assert.equal(statements.length,1);assert.equal(providerRequests,0);
    // Current enablement is re-read each alarm. Enabled but absent/unverified credentials also skip.
    raw.exec("UPDATE installations SET discord_enabled=1 WHERE id='primary'");
    assert.equal(await pass(),'ok');assert.equal(providerRequests,0);assert.equal(statements.some(sql=>sql.includes('ciphertext')),false);
    raw.exec("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at) VALUES('discord','primary','discord','invalid-not-decrypted','invalid','2026-01-01')");
    assert.equal(await pass(),'ok');assert.equal(providerRequests,0);assert.equal(statements.some(sql=>sql.includes('ciphertext')),false);
    const encrypted=await encryptIntegration({botToken:'synthetic-only',guildId:'100000000000000000',channelId:'200000000000000000'},secret);
    raw.prepare("UPDATE encrypted_integrations SET ciphertext=?,iv=?,verified_at='2026-01-01'").run(encrypted.ciphertext,encrypted.iv);
    raw.exec("UPDATE installations SET discord_enabled=0 WHERE id='primary'");
    assert.equal(await pass(),'ok');assert.equal(providerRequests,0);assert.equal(statements.length,1);
    env.INTEGRATION_KEY=secret;
    const manualHeaders={'content-type':'application/json',cookie:'lancerlogin_session='+await createSessionCodec(secret).issue({userId:'admin',role:'admin'})};
    const manual=await worker.fetch(new Request('https://fixture.invalid/discord/kiosk-status',{method:'POST',headers:manualHeaders,body:'{}'}),env);assert.equal(manual.status,503);assert.equal((await manual.json()).error,'Discord is not enabled');
    raw.exec("UPDATE installations SET discord_enabled=1 WHERE id='primary'");env.INTEGRATION_KEY=secret;
    assert.equal(await pass(),'failed');assert.equal(providerRequests,1);assert.ok(statements.length<=32);
    state.jobs['core.telemetry']={next:0,last:null,outcome:'waiting'};await scheduler.alarm();assert.equal(state.jobs['core.telemetry'],undefined);assert.equal(state.jobs['attendance.discord-channel'].outcome,'failed');assert.equal(providerRequests,1);
    // DB outages and broken enabled credentials must not be swallowed as disabled setup.
    raw.exec("UPDATE encrypted_integrations SET ciphertext='broken'");assert.equal(await pass(),'failed');assert.equal(providerRequests,1);
    env.DB={prepare:()=>{throw Error('synthetic DB unavailable');}};assert.equal(await pass(),'failed');assert.equal(providerRequests,1);
  } finally { globalThis.fetch=previousFetch;raw.close(); }
});
test('real SQLite notice pass skips delivered backlog, sends one message, batches recipients and preserves retry identity', async () => {
  const raw = new DatabaseSync(':memory:'); let queries = 0, requests = [];
  const originalFetch = globalThis.fetch;
  try {
    for (const f of readdirSync(new URL('../apps/api/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) raw.exec(readFileSync(new URL('../apps/api/migrations/' + f, import.meta.url), 'utf8'));
    raw.exec(`INSERT INTO installations(id,created_at,auth_mode,discord_enabled) VALUES('primary','2026-01-01','local',1);
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','fixture','admin','2026-01-01');
      INSERT INTO organization_settings(installation_id,time_zone) VALUES('primary','UTC');`);
    const encrypted = await encryptIntegration({ botToken: 'synthetic-only', guildId: '100000000000000000', channelId: '200000000000000000' }, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    raw.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES('fixture','primary','discord',?,?,?,?)").run(encrypted.ciphertext, encrypted.iv, '2026-01-01', '2026-01-01');
    for (let i = 0; i < 105; i++) {
      raw.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES(?,'primary','Synthetic meeting','2026-01-01T10:00:00Z','2026-01-01T11:00:00Z','admin','2026-01-01')").run('meeting-' + i);
      if (i < 103) raw.prepare("INSERT INTO discord_attendance_notifications(installation_id,meeting_id,status,attempts,updated_at) VALUES('primary',?,'delivered',1,'2026-01-01')").run('meeting-' + i);
    }
    for (let i = 0; i < 20; i++) raw.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,discord_user_id,created_at) VALUES(?,'primary',?,'Synthetic','Member',?,'2026-01-01')").run('member-' + i, 'fixture-' + i, String(300000000000000000n + BigInt(i)));
    const db = {
      prepare(sql) { let values = []; return { bind(...v) { values = v; return this; }, async first() { queries++; return raw.prepare(sql).get(...values) ?? null; }, async all() { queries++; return { results: raw.prepare(sql).all(...values) }; }, async run() { queries++; const r = raw.prepare(sql).run(...values); return { meta: { changes: Number(r.changes) } }; } }; },
      async batch(statements) { raw.exec('BEGIN'); try { const result = []; for (const s of statements) result.push(await s.run()); raw.exec('COMMIT'); return result; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
    };
    globalThis.fetch = async (url, init) => { assert.equal(url, 'https://discord.com/api/v10/channels/200000000000000000/messages'); requests.push(JSON.parse(init.body)); return Response.json({ id: '400000000000000000' }); };
    let state = { enabled: true, jobs: { 'attendance.discord-notices': { next: 0, last: null, outcome: 'waiting' } } };
    const storage = { transaction: async callback => callback(), get: async () => structuredClone(state), put: async (_, value) => { state = structuredClone(value); }, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
    const env = { DB: db, APP_MODE: 'configured', ALLOWED_ORIGIN: 'https://fixture.invalid', SESSION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', INTEGRATION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', PLATFORM_SCHEDULER_MODE: 'durable' };
    const scheduler = new PlatformScheduler({ storage }, env);
    env.PLATFORM_SCHEDULER = { idFromName: name => { assert.equal(name, 'primary'); return name; }, get: () => ({ fetch: req => scheduler.fetch(req) }) };
    await scheduler.alarm();
    assert.equal(requests.length, 1); assert.equal(requests[0].enforce_nonce, true); assert.equal(requests[0].allowed_mentions.users.length, 20);
    assert.equal(raw.prepare('SELECT count(*) AS n FROM discord_attendance_recipients').get().n, 20);
    assert.ok(queries <= 12, `actual SQLite statements: ${queries}`);
    const delivered = raw.prepare("SELECT meeting_id FROM discord_attendance_recipients LIMIT 1").get().meeting_id;
    raw.prepare("UPDATE discord_attendance_notifications SET status='failed' WHERE meeting_id=?").run(delivered);
    raw.prepare("UPDATE meetings SET deleted_at='2026-01-01' WHERE id<>?").run(delivered);
    state.jobs['attendance.discord-notices'].next = 0; queries = 0; await scheduler.alarm();
    assert.equal(requests.length, 2); assert.equal(requests[0].nonce, requests[1].nonce); assert.ok(queries <= 12);
    const token = await createSessionCodec(env.SESSION_KEY).issue({ userId: 'admin', role: 'admin' });
    const headers = { cookie: 'lancerlogin_session=' + token, 'content-type': 'application/json' };
    assert.equal((await worker.fetch(new Request('https://fixture.invalid/admin/scheduler', { headers }), env)).status, 200);
    assert.equal((await worker.fetch(new Request('https://fixture.invalid/admin/scheduler/start', { method: 'POST', headers, body: '{"interval":1}' }), env)).status, 400);
    raw.exec("UPDATE users SET role='operator' WHERE id='admin'");
    assert.equal((await worker.fetch(new Request('https://fixture.invalid/admin/scheduler', { headers }), env)).status, 403);
    assert.equal((await scheduler.fetch(new Request('https://internal.invalid/stop', { method: 'POST', headers }))).status, 403);
    raw.exec("UPDATE users SET active=0 WHERE id='admin'");
    assert.equal((await worker.fetch(new Request('https://fixture.invalid/admin/scheduler', { headers }), env)).status, 401);

  } finally { globalThis.fetch = originalFetch; raw.close(); }
});
