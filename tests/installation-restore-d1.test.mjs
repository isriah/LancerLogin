// quick-check: covers apps/api/migrations/**
// Entire-installation backup and restore on real local D1 (Miniflare's workerd): the backup's one batch of reads returns
// every table's rows, the restore's multi-row INSERT statements stay within D1's 100 bound parameters, and the restoring
// Admin's session continues under the new epoch. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniflareD1 } from './fixtures/miniflare-d1.mjs';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';

test('local D1 backs up an installation in one batch and restores it with multi-row statements', { timeout: 120000 }, async () => {
  const { runtime: mf, database: db } = await createMiniflareD1();
  try {
    await db.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at,session_epoch) VALUES ('admin','primary','admin','admin','2026-01-01',2);
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,0);
      INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) VALUES ('primary','admin',0);
      INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) VALUES ('primary','admin',0);
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<40) INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) SELECT 'test-member-'||x,'primary','T-'||x,'Test Student',CAST(x AS TEXT),'2026-01-01','2026-01-01' FROM n;
      INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,created_by,created_at) VALUES ('test-meeting','primary','Test Meeting','2026-02-02T18:00:00.000Z','2026-02-02T20:00:00.000Z','admin','2026-01-01');
      INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,action) SELECT 'test-'||a.action||'-'||m.id,'primary',m.id,'test-meeting','manual',CASE a.action WHEN 'check_in' THEN '2026-02-02T18:00:00.000Z' ELSE '2026-02-02T20:00:00.000Z' END,a.action FROM members m CROSS JOIN (SELECT 'check_in' AS action UNION ALL SELECT 'check_out') a;
      INSERT INTO kiosk_possible_wrong_matches(installation_id,kiosk_event_id,kiosk_id,member_id,occurred_at,other_kiosk_event_id,other_kiosk_id,other_occurred_at,recorded_at) VALUES('primary','test-event-1','test-kiosk-1','test-member-1','2026-01-01T00:00:00Z','test-event-2','test-kiosk-2','2026-01-01T00:00:05Z','2026-11-01T00:00:00Z');`.replace(/\n/g, ' '));
    // The limit the restore's statements are sized for is the one this D1 enforces.
    await assert.rejects(db.prepare(`SELECT ${Array.from({ length: 101 }, () => '?').join(',')}`).bind(...Array.from({ length: 101 }, (_, index) => index)).all());
    const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    let cookie = 'lancerlogin_session=' + await createSessionCodec(secret).issue({ userId: 'admin', role: 'admin', epoch: 2 });
    const revoked = 'lancerlogin_session=' + await createSessionCodec(secret).issue({ userId: 'admin', role: 'admin' });
    const fetch = (path, session, body) => worker.fetch(new Request('https://fixture.test' + path, { method: body ? 'POST' : 'GET', headers: { cookie: session, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: db, SESSION_KEY: secret, APP_MODE: 'configured' });
    const exported = await fetch('/admin/data/backup?scope=installation', cookie);
    assert.equal(exported.status, 200, await exported.clone().text());
    const backup = await exported.json();
    assert.deepEqual([backup.tables.installations.length, backup.tables.members.length, backup.tables.meetings.length, backup.tables.attendance_events.length, backup.tables.users.length], [1, 40, 1, 80, 1]);
    const events = async () => (await db.prepare('SELECT id, member_id, meeting_id, source, occurred_at, action FROM attendance_events ORDER BY id').all()).results;
    const before = await events();
    await db.prepare("DELETE FROM attendance_events WHERE member_id = 'test-member-7'").run();

    const restored = await fetch('/admin/data/restore', cookie, { scope: 'installation', confirmation: 'RESTORE INSTALLATION', backup });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.deepEqual(await events(), before);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM members').first()).n, 40);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM kiosk_possible_wrong_matches').first()).n, 0);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
    // The old cookie and the revoked one are both refused; the cookie the restore set carries on.
    assert.deepEqual([(await fetch('/auth/session', cookie)).status, (await fetch('/auth/session', revoked)).status], [401, 401]);
    cookie = restored.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch('/auth/session', cookie)).status, 200);
    assert.ok((await db.prepare("SELECT session_epoch AS epoch FROM users WHERE id='admin'").first()).epoch > 2);
    // The restored state backs up and restores again.
    const again = await (await fetch('/admin/data/backup?scope=installation', cookie)).json();
    assert.deepEqual(again.tables.attendance_events, backup.tables.attendance_events);
    assert.equal((await fetch('/admin/data/restore', cookie, { scope: 'installation', confirmation: 'RESTORE INSTALLATION', backup: again })).status, 200);
  } finally { await mf.dispose(); }
});
