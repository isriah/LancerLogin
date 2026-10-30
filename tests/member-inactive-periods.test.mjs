import test from 'node:test';
import { omitContestResubmissionFields } from '../tests-ts/fixtures/backup-versions.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../apps/api/src/index.ts';
import { createSessionCodec } from '../apps/api/src/runtime-security.ts';
import { encryptIntegration } from '../apps/api/src/integration-crypto.ts';
import { evaluateAttendance } from '../apps/api/src/attendance-policy.ts';
import { inactiveAt, inactiveAtSql, validateInactivePeriods } from '../apps/api/src/member-participation.ts';

const migrations = new URL('../apps/api/migrations/', import.meta.url);
const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
class Database {
  raw = new DatabaseSync(':memory:');
  now = '2026-02-01T12:00:00.000Z';
  constructor() {
    this.raw.exec('PRAGMA foreign_keys=ON');
    this.raw.function('strftime', (format, when) => {
      assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(when, 'now'); return this.now;
    });
    for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) this.raw.exec(readFileSync(new URL(file, migrations), 'utf8'));
    this.raw.exec(`INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'),('other','2026-01-01','local');
      INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES ('admin','primary','admin','admin','2026-01-01'),('operator','primary','operator','operator','2026-01-01');
      INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at,attendance_required_from) VALUES ('member','primary','001','Synthetic','Member','2026-01-01','2026-01-01'),('foreign','other','001','Foreign','Member','2026-01-01','2026-01-01');`);
    this.raw.exec(`INSERT INTO hours_entry_settings(installation_id) SELECT id FROM installations;
      INSERT INTO platform_module_assignment_epochs(installation_id,user_id,revision) SELECT installation_id,id,0 FROM users;
      INSERT INTO platform_module_assignment_revisions(installation_id,user_id,revision) SELECT installation_id,id,0 FROM users;
      INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','UTC');
      INSERT INTO platform_module_administration(installation_id,revision,selection_completed) VALUES ('primary',0,1);
      INSERT INTO platform_module_administration_epochs(installation_id,revision) VALUES ('primary',0);
      INSERT INTO platform_module_epochs(installation_id,module_id,generation) VALUES ('primary','attendance',1),('primary','hour-tracking',1);
      INSERT INTO platform_modules(installation_id,module_id,contract_version,generation,phase,setup_version,setup_complete) VALUES ('primary','attendance',1,1,'enabled',2,1),('primary','hour-tracking',1,1,'disabled',1,0);
      INSERT INTO platform_module_setup_progress(installation_id,module_id,step_id,setup_version,outcome,completed_at,completed_by) SELECT 'primary','attendance',value,2,'completed','2026-01-01T00:00:00.000Z','admin' FROM json_each('["rules","meeting","input"]');`);
  }
  prepare(sql) {
    let values = []; const db = this;
    return { bind(...args) { values = args; return this; },
      async first() { return db.raw.prepare(sql).get(...values) ?? null; },
      async all() { return { results: db.raw.prepare(sql).all(...values) }; },
      async run() { if (/^\s*SELECT\b/i.test(sql)) return { success: true, results: db.raw.prepare(sql).all(...values) }; const result = db.raw.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; }
    };
  }
  pending = Promise.resolve();
  batch(statements) { const result = this.pending.then(() => this.transaction(statements)); this.pending = result.catch(() => {}); return result; }
  async transaction(statements) {
    this.raw.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.raw.exec('COMMIT'); return results; }
    catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
  periods() { return JSON.parse(this.raw.prepare("SELECT inactive_periods_json FROM members WHERE id='member'").get().inactive_periods_json); }
}
async function call(db, path, body, method = body ? 'POST' : 'GET', user = 'admin') {
  const cookie = 'lancerlogin_session=' + await createSessionCodec(secret).issue({ userId: user, role: user === 'admin' ? 'admin' : 'operator' });
  return worker.fetch(new Request('https://fixture.test' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: db, SESSION_KEY: secret, INTEGRATION_KEY: secret, APP_MODE: 'configured' });
}
async function good(db, path, body, method) {
  const response = await call(db, path, body, method); assert.ok(response.ok, await response.clone().text()); return response.json();
}
const change = (db, active) => good(db, '/admin/members/member', { active }, 'PATCH');
const member = { memberId: '001', firstName: 'Synthetic', lastName: 'Member' };

test('deactivate/reactivate preserves repeated intervals, status idempotence, authorization and tenant isolation', async t => {
  const db = new Database(); t.after(() => db.raw.close());
  assert.equal((await call(db, '/admin/members/member', { active: false }, 'PATCH', 'operator')).status, 403);
  assert.equal((await call(db, '/admin/members/foreign', { active: false }, 'PATCH')).status, 404);
  assert.equal((await call(db, '/admin/members/member', { active: 'false' }, 'PATCH')).status, 400);
  await Promise.all([change(db, false), change(db, false)]);
  assert.deepEqual(db.periods(), [['2026-02-01T12:00:00.000Z', null]]);
  db.now = '2026-03-01T12:00:00.000Z'; await change(db, true); await change(db, true);
  db.now = '2026-04-01T12:00:00.000Z'; await change(db, false);
  await good(db, '/admin/members/member', { firstName: 'Updated' }, 'PATCH');
  db.now = '2026-05-01T12:00:00.000Z'; await change(db, true);
  assert.deepEqual(db.periods(), [['2026-02-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z'], ['2026-04-01T12:00:00.000Z', '2026-05-01T12:00:00.000Z']]);
  assert.equal(db.raw.prepare("SELECT inactive_periods_json FROM members WHERE id='foreign'").get().inactive_periods_json, '[]');
});

test('CSV replacement and merge retain the same identity, start date and inactive periods', async t => {
  const db = new Database(); t.after(() => db.raw.close());
  await good(db, '/admin/members', { mode: 'replace', members: [member] }); assert.deepEqual(db.periods(), []);
  await good(db, '/admin/members', { mode: 'replace', members: [{ memberId: '002', firstName: 'Another', lastName: 'Member' }] });
  assert.deepEqual(db.periods(), [[db.now, null]]);
  db.now = '2026-03-01T12:00:00.000Z'; await good(db, '/admin/members', { mode: 'merge', members: [member] });
  assert.deepEqual(db.periods(), [['2026-02-01T12:00:00.000Z', db.now]]);
  assert.equal(db.raw.prepare("SELECT attendance_required_from FROM members WHERE id='member'").get().attendance_required_from, '2026-01-01');
  await good(db, '/admin/members', { mode: 'replace', members: [member] }); assert.equal(db.periods().length, 1);
});

test('meeting eligibility survives reactivation across attendance, weighted reports, history and CSV', async t => {
  const db = new Database(); t.after(() => db.raw.close());
  await change(db, false); db.now = '2026-03-01T12:00:00.000Z'; await change(db, true);
  const dates = ['2026-01-20T12:00:00.000Z', '2026-02-01T12:00:00.000Z', '2026-02-15T12:00:00.000Z', '2026-03-01T12:00:00.000Z'];
  const meetings = dates.map((startsAt, i) => ({ id: 'meeting-' + i, title: 'Meeting ' + i, startsAt, endsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(), attendanceWeight: i === 2 ? 3 : 1 }));
  for (const m of meetings) db.raw.prepare("INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,created_by,created_at,attendance_weight) VALUES (?,'primary',?,?,?,1,'admin','2026-01-01',?)").run(m.id, m.title, m.startsAt, m.endsAt, m.attendanceWeight);
  db.raw.exec("INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) VALUES ('present','primary','member','meeting-0','present','Recorded presence','admin','2026-01-20'),('gap','primary','member','meeting-2','absent','Preserved correction','admin','2026-02-15')");
  const rows = {};
  for (const m of meetings) rows[m.id] = (await good(db, '/attendance?includeInactive=1&meetingId=' + m.id)).attendance;
  assert.deepEqual(meetings.map(m => rows[m.id][0].disposition), ['present', 'not_required', 'not_required', 'absent']);
  const { members: [stats] } = await good(db, '/reports/attendance'); assert.equal(stats.present, 1); assert.equal(stats.primaryTotal, 2); assert.equal(stats.adjustedTotal, 2);
  const history = await good(db, '/admin/members/001/history');
  assert.equal(history.history.find(row => row.meetingId === 'meeting-2').disposition, 'not_required');
  assert.equal(history.history.find(row => row.meetingId === 'meeting-2').reason, 'Preserved correction');
  const csv = await (await call(db, '/exports/attendance.csv')).text(); assert.match(csv, /Meeting 0/); assert.match(csv, /Meeting 3/); assert.doesNotMatch(csv, /Meeting [12]/);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM attendance_corrections').get().n, 2);
  db.raw.exec("UPDATE members SET email='synthetic@example.test' WHERE id='member'");
  const email = await call(db, '/communications/email', { kind: 'missed-meeting', memberId: 'member', meetingId: 'meeting-2' });
  assert.equal(email.status, 409); assert.match((await email.json()).error, /not currently marked absent/);
  const encrypted = await encryptIntegration({ botToken: 'synthetic-token', guildId: '111111111111111111', channelId: '222222222222222222' }, secret);
  db.raw.prepare("INSERT INTO encrypted_integrations(id,installation_id,provider,ciphertext,iv,updated_at,verified_at) VALUES ('discord','primary','discord',?,?,'2026-01-01','2026-01-01')").run(encrypted.ciphertext, encrypted.iv);
  db.raw.exec("UPDATE installations SET discord_enabled=1 WHERE id='primary'; UPDATE members SET discord_user_id='333333333333333333' WHERE id='member'");
  const notification = await good(db, '/discord/missing', { meetingId: 'meeting-2' });
  assert.equal(notification.posted, false); assert.equal(notification.linkedMissingCount, 0);
});

test('roster and installation backups retain periods and reject invalid history before writing', async t => {
  const db = new Database(); t.after(() => db.raw.close());
  await change(db, false); db.now = '2026-03-01T12:00:00.000Z'; await change(db, true);
  const periods = db.periods();
  for (const scope of ['roster', 'installation']) {
    const backup = await good(db, '/admin/data/backup?scope=' + scope); assert.equal(backup.schemaVersion, 45);
    const row = backup.tables.members.find(m => m.id === 'member'); assert.deepEqual(JSON.parse(row.inactive_periods_json), periods); assert.equal(row.attendance_required_from, '2026-01-01');
    const invalid = structuredClone(backup); invalid.tables.members[0].inactive_periods_json = '[["2026-03-01", "2026-02-01"]]';
    assert.equal((await call(db, '/admin/data/restore', { scope, confirmation: 'RESTORE ' + scope.toUpperCase(), backup: invalid })).status, 400);
    assert.deepEqual(db.periods(), periods);
    db.raw.exec("UPDATE members SET inactive_periods_json='[]' WHERE id='member'");
    await good(db, '/admin/data/restore', { scope, confirmation: 'RESTORE ' + scope.toUpperCase(), backup }); assert.deepEqual(db.periods(), periods);
  }
  const legacy = await good(db, '/admin/data/backup?scope=roster'); legacy.schemaVersion = 33; omitContestResubmissionFields(legacy);
  for (const row of legacy.tables.members) { delete row.inactive_periods_json; row.active = 0; }
  await good(db, '/admin/data/restore', { scope: 'roster', confirmation: 'RESTORE ROSTER', backup: legacy });
  assert.equal(db.periods().length, 1); assert.equal(db.periods()[0][1], null); assert.ok(Date.parse(db.periods()[0][0]) > Date.parse('2026-05-01'));
});

test('migration retains populated history and initializes existing inactive members only from migration time', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync(migrations).filter(f => f.endsWith('.sql') && f < '0062').sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    db.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES ('primary','2026-01-01','local'); INSERT INTO members(id,installation_id,external_id,first_name,last_name,active,created_at) VALUES ('old','primary','old','Former','Member',0,'2026-01-01')");
    db.exec(readFileSync(new URL('0062_member_inactive_periods.sql', migrations), 'utf8'));
    const row = db.prepare("SELECT * FROM members WHERE id='old'").get();
    assert.equal(row.created_at, '2026-01-01'); const periods = JSON.parse(row.inactive_periods_json); assert.equal(periods[0][1], null); assert.ok(Date.now() - Date.parse(periods[0][0]) < 5000);
  } finally { db.close(); }
});


test('JS and SQL agree on inclusive start, exclusive end, offsets and multiple gaps; backup validation rejects overlaps', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const json = JSON.stringify([['2026-02-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z'], ['2026-04-01T12:00:00.000Z', null]]);
    for (const [instant, expected] of [['2026-02-01T11:59:59.999Z', false], ['2026-02-01T07:00:00-05:00', true], ['2026-03-01T11:59:59.999Z', true], ['2026-03-01T12:00:00Z', false], ['2026-05-01T12:00:00Z', true]]) {
      assert.equal(inactiveAt(json, instant), expected);
      assert.equal(Boolean(db.prepare(`SELECT ${inactiveAtSql('?1', '?2')} AS inactive`).get(json, instant).inactive), expected);
    }
    validateInactivePeriods(json, 0);
    for (const value of ['{}', '[["bad",null]]', '[["2026-02-01",null],["2026-03-01",null]]', '[["2026-03-01","2026-02-01"]]']) assert.throws(() => validateInactivePeriods(value, 0));
    assert.throws(() => validateInactivePeriods(json, 1)); assert.throws(() => validateInactivePeriods('[]', 0));
  } finally { db.close(); }
});

test('bulk status changes record one interval and preserve it after reactivation', async t => {
  const db = new Database(); t.after(() => db.raw.close());
  for (const active of [false, false, true]) {
    if (active) db.now = '2026-03-01T12:00:00.000Z';
    const input = { memberIds: ['member'], active };
    const preview = await good(db, '/admin/members/bulk/preview', input);
    await good(db, '/admin/members/bulk/apply', { ...input, previewToken: preview.previewToken });
  }
  assert.deepEqual(db.periods(), [['2026-02-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z']]);
});

test('inactive opportunities stay outside weekly, percentage, regular and historical policy totals', () => {
  const periods = JSON.stringify([['2026-09-08T00:00:00.000Z', '2026-09-10T00:00:00.000Z']]);
  const meetings = [7,8,9,10].map(day => ({ id: 'm'+day, title: 'Synthetic', startsAt: '2026-09-'+day.toString().padStart(2,'0')+'T12:00:00.000Z', endsAt: '2026-09-'+day.toString().padStart(2,'0')+'T13:00:00.000Z', attendanceClosesAt: '2026-09-'+day.toString().padStart(2,'0')+'T13:30:00.000Z', required: true, attendanceWeight: 1, audienceMode: 'all', audienceLabelIds: [] }));
  for (const ruleType of ['weekly_count','weighted_percentage']) {
    const result = evaluateAttendance({ members: [{ id: 'member', memberId: '001', firstName: 'Synthetic', lastName: 'Member', active: 1, inactivePeriodsJson: periods }], labels: [{id:'label',name:'Policy',active:1,formulaEnabled:0}], changes:[{memberId:'member',labelId:'label',action:'add',effectiveDate:'2026-01-01'}], rules:[{id:'rule',labelId:'label',ruleType,meetingsPerWeek:3,thresholdPercent:80}], meetings, observations:[{memberId:'member',meetingId:'m7',disposition:'present'},{memberId:'member',meetingId:'m10',disposition:'present'}], timeZone:'UTC', now:'2026-09-14T12:00:00.000Z' })[0];
    assert.deepEqual(result.rows.map(row=>row.meetingId), ['m7','m10']);
    assert.equal(result.regularAttendance.required, 2); assert.equal(result.regularAttendance.rate, 100);
    assert.equal(result.historySummaries[0].rate, 100);
    if(ruleType === 'weekly_count') { assert.equal(result.weeks[0].opportunities, 2); assert.equal(result.weeks[0].belowTarget, false); }
    else { assert.equal(result.currentCompliance.required, 2); assert.equal(result.currentCompliance.rate, 100); }
  }
});

