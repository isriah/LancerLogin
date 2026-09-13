import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

test('actual workerd SQLite alarms run without an open request and survive runtime replacement', async () => {
  const persistence = await mkdtemp(join(tmpdir(), 'lancerlogin-scheduler-'));
  const source = `import {schedulerClass} from './apps/api/src/platform-scheduler.ts';
    const jobs=['fails','succeeds','module'].map(id=>({id,interval:300000,
      enabled: async env=>id!=='module'||!!(await env.DB.prepare('SELECT enabled FROM fixture').first()).enabled,
      run:async env=>{await env.DB.prepare('INSERT INTO calls(id) VALUES (?)').bind(id).run(); if(id==='fails')throw Error('private synthetic error');}}));
    const Base=schedulerClass(jobs,async req=>req.headers.get('authorization')==='synthetic-admin',env=>env.MODE==='durable');
    export class Fixture extends Base {
      constructor(state,env){super(state,env);this.storage=state.storage;}
      async fetch(req){
        if(new URL(req.url).pathname==='/fixture/alarm-state')return Response.json({alarm:await this.storage.getAlarm()});
        if(new URL(req.url).pathname==='/fixture/alarm'){await super.alarm();return new Response('done');}
        if(new URL(req.url).pathname==='/fixture/due'){
          const v=await this.storage.get('scheduler-v1');for(const j of Object.values(v.jobs))j.next=0;
          await this.storage.put('scheduler-v1',v);await this.storage.setAlarm(Date.now()+200);return new Response('queued');
        }return super.fetch(req);
      }
    }
    export default {fetch(req,env){return env.SCHEDULER.get(env.SCHEDULER.idFromName('primary')).fetch(req);}};`;
  const bundled = await build({ stdin: { contents: source, resolveDir: resolve('.') }, bundle: true, format: 'esm', write: false, platform: 'browser' });
  const optionsFor = mode => convertV4MiniflareOptions({ bindings: { MODE: mode }, modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-08-01', durableObjects: { SCHEDULER: { className: 'Fixture', useSQLite: true } }, d1Databases: ['DB'], resourcePersistencePath: persistence, telemetry: { enabled: false } });
  const options = optionsFor('durable');
  let mf = new Miniflare(options);
  const get = async path => (await mf.dispatchFetch(`https://fixture.invalid/${path}`, { headers: { authorization: 'synthetic-admin' }, method: path === 'status' ? 'GET' : 'POST' }));
  try {
    let db = await mf.getD1Database('DB');
    await db.batch([db.prepare('CREATE TABLE fixture(enabled INTEGER)'), db.prepare('INSERT INTO fixture VALUES(0)'), db.prepare('CREATE TABLE calls(id TEXT)')]);
    assert.equal((await mf.dispatchFetch('https://fixture.invalid/start', { method: 'POST' })).status, 403);
    await Promise.all([get('start'), get('start')]); await get('fixture/due');
    await mf.dispose(); mf = new Miniflare(options); await mf.ready;
    let status;
    for (let i = 0; i < 50; i++) {
      status = await (await get('status')).json();
      if (Object.values(status.jobs).every(j => ['ok', 'failed', 'paused'].includes(j.outcome))) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(status.jobs.fails.outcome, 'failed'); assert.equal(status.jobs.succeeds.outcome, 'ok'); assert.equal(status.jobs.module.outcome, 'paused');
    db = await mf.getD1Database('DB'); assert.deepEqual((await db.prepare('SELECT id FROM calls ORDER BY rowid').all()).results, [{ id: 'fails' }, { id: 'succeeds' }]);
    // A temporary mode-off deployment removes the alarm without clearing enabled state.
    await mf.dispose(); mf = new Miniflare(optionsFor('off'));
    await get('fixture/due'); await get('fixture/alarm');
    assert.equal((await (await get('fixture/alarm-state')).json()).alarm, null);
    await mf.dispose(); mf = new Miniflare(options);
    const retained = await (await get('status')).json(); assert.equal(retained.enabled, true);
    await Promise.all([get('start'), get('start')]);
    const firstAlarm = (await (await get('fixture/alarm-state')).json()).alarm; assert.ok(firstAlarm > 0);
    await get('status'); await get('start');
    assert.equal((await (await get('fixture/alarm-state')).json()).alarm, firstAlarm);
    for (let i = 0; i < 50; i++) {
      status = await (await get('status')).json();
      if (Object.values(status.jobs).every(j => j.next > Date.now())) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    db = await mf.getD1Database('DB');
    assert.deepEqual((await db.prepare('SELECT id, count(*) AS n FROM calls GROUP BY id ORDER BY id').all()).results, [{ id: 'fails', n: 2 }, { id: 'succeeds', n: 2 }]);
    await get('stop'); await mf.dispose(); mf = new Miniflare(options);
    assert.equal((await (await get('status')).json()).enabled, false);
  } finally { await mf.dispose(); assert.equal(dirname(resolve(persistence)), resolve(tmpdir())); await rm(persistence, { recursive: true, force: true }); }
});
