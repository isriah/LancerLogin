import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';

test('local D1 records concurrent status transitions once and restores roster history atomically', { timeout: 60000 }, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    const migrations = new URL('../apps/api/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(name, migrations), 'utf8').replace(/^\s*--.*$/gm, '').replace(/\r?\n/g, ' '));
    await db.batch([
      db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local')"),
      db.prepare("INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01')"),
      db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) VALUES ('member','primary','001','Synthetic','Member','2026-01-01','2026-01-01')"),
    ]);
    await db.prepare("INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC')").run();
    const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const cookie = 'lancerlogin_session=' + await createSessionCodec(secret).issue({ userId: 'admin', role: 'admin' });
    const call = async (path, body, method = body ? 'POST' : 'GET') => {
      const response = await worker.fetch(new Request('https://fixture.test' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: db, SESSION_KEY: secret, APP_MODE: 'configured' });
      assert.ok(response.ok, await response.clone().text()); return response.json();
    };
    await Promise.all([false, false].map(active => call('/admin/members/member', { active }, 'PATCH')));
    const inactive = await db.prepare("SELECT inactive_periods_json AS periods FROM members WHERE id='member'").first();
    assert.equal(JSON.parse(inactive.periods).length, 1); assert.equal(JSON.parse(inactive.periods)[0][1], null);
    await Promise.all([true, true].map(active => call('/admin/members/member', { active }, 'PATCH')));
    const active = await db.prepare("SELECT inactive_periods_json AS periods FROM members WHERE id='member'").first();
    assert.equal(JSON.parse(active.periods).length, 1); assert.ok(JSON.parse(active.periods)[0][1]);
    const backup = await call('/admin/data/backup?scope=roster');
    await call('/admin/data/restore', { scope: 'roster', confirmation: 'RESTORE ROSTER', backup });
    assert.equal((await db.prepare("SELECT inactive_periods_json AS periods FROM members WHERE id='member'").first()).periods, active.periods);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
  } finally { await mf.dispose(); }
});
