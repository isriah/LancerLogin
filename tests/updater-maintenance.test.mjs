import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceCore } from '../apps/updater/src/maintenance.mjs';
import { admitExecutionScope } from '../apps/updater/src/execution-scope.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const execution = Object.freeze({}), maintenance = Object.freeze({});
const id = () => crypto.randomUUID();
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-'));
  const one = new DatabaseSync(join(dir, 'updater.sqlite'));
  one.exec(readFileSync(new URL('../apps/updater/state/0005_updater_maintenance.sql', import.meta.url), 'utf8'));
  const two = new DatabaseSync(join(dir, 'updater.sqlite'));
  const app = new DatabaseSync(join(dir, 'app.sqlite'));
  app.exec('CREATE TABLE data(value TEXT);');
  t.after(() => { one.close(); two.close(); app.close(); rmSync(dir, { recursive: true, force: true }); });
  const controls = { fail: null, lose: null, evidence: true, resolve: async () => null, queries: 0, sessions: 0 };
  const database = sqlite => ({
    prepare() { throw Error('non-primary query'); },
    withSession(mode) {
      assert.equal(mode, 'first-primary'); controls.sessions++;
      return { prepare(sql) { return { bind(...args) { return { async first() {
        controls.queries++;
        if (controls.fail?.(sql)) { controls.fail = null; throw Error('storage unavailable'); }
        const result = sqlite.prepare(sql).get(...args) ?? null;
        if (controls.lose?.(sql)) { controls.lose = null; throw Error('lost acknowledgment'); }
        return result;
      } }; } }; } };
    },
  });
  const make = (sqlite = one, installationId = 'synthetic') => createMaintenanceCore({ database: database(sqlite), installationId, executionCapability: execution, maintenanceCapability: maintenance,
    readReopenEvidence: async context => controls.evidence ? { ...context, jobTerminal: true, healthVerified: true } : null,
    resolveOperation: context => controls.resolve(context),
  });
  const core = make(); await core.initialize(maintenance);
  return { core, other: make(two), make, one, app, controls,
    scope: () => admitExecutionScope({ core, capability: execution }),
    close: () => core.close(maintenance, { epoch: 0, jobId: 'job' }),
  };
}

test('atomic admission/close across SQLite connections, bounded indexed readiness, exact reopening', async t => {
  const f = await fixture(t);
  const [{ permit }, closing] = await Promise.all([
    f.core.admit(execution, { permitId: id() }), f.other.close(maintenance, { epoch: 0, jobId: 'job' }),
  ]);
  assert.equal(closing.state, 'draining');
  assert.equal((await f.core.ready(maintenance, 1)).state, 'draining');
  assert.equal((await f.core.status(maintenance)).blocker.permitId, permit.id);
  assert.equal((await f.other.admit(execution, { permitId: id() })).status, 'not-admitted');
  await assert.rejects(f.core.ready({}, 1), /authorization/);
  await f.core.release(execution, permit);
  assert.equal((await f.core.ready(maintenance, 1)).state, 'closed');
  f.controls.evidence = false;
  await assert.rejects(f.core.reopen(maintenance, 1), /health-required/);
  await assert.rejects(f.core.reopen(maintenance, 0), /conflict/);
  f.controls.evidence = true;
  assert.equal((await f.core.reopen(maintenance, 1)).state, 'open');
  assert.equal((await f.core.reopen(maintenance, 1)).state, 'open');
  await f.other.close(maintenance, { epoch: 1, jobId: 'next' });
  assert.equal((await f.core.admit(execution, { permitId: id() })).status, 'not-admitted');
  const plan = f.one.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM updater_execution_permits WHERE installation_id=? AND state='active'").all('synthetic');
  assert.match(JSON.stringify(plan), /updater_active_permits/);
  assert.equal(f.controls.queries, f.controls.sessions);
});

test('lost admission acknowledgment and crash never grant a replacement execution or orphan release', async t => {
  const f = await fixture(t), permitId = id();
  f.controls.lose = sql => sql.startsWith('INSERT INTO updater_execution_permits');
  await assert.rejects(f.core.admit(execution, { permitId }), /lost acknowledgment/);
  assert.equal((await f.other.admit(execution, { permitId })).status, 'not-admitted');
  const diagnostic = await f.other.lookup(maintenance, permitId);
  assert.equal(diagnostic.state, 'active');
  await assert.rejects(f.other.release(execution, diagnostic), /maintenance-permit/);
  await f.close();
  assert.equal((await f.other.ready(maintenance, 1)).state, 'draining');
  await assert.rejects(f.make(f.one, 'wrong').initialize(maintenance), /installation/);
});

test('lost release acknowledgment is idempotent and released identities never readmit', async t => {
  const f = await fixture(t), scope = await f.scope();
  f.controls.lose = sql => sql.startsWith('UPDATE updater_execution_permits');
  await scope.run(() => 'ok');
  assert.deepEqual(await scope.done, { status: 'release-unknown' });
  assert.deepEqual(await scope.retryRelease(), { status: 'released' });
  assert.equal((await f.core.admit(execution, { permitId: scope.permitId })).status, 'not-admitted');
  await f.close(); assert.equal((await f.core.ready(maintenance, 1)).state, 'closed');
});

test('nested waitUntil and deadline-raced underlying work keep the permit until actual completion', async t => {
  const f = await fixture(t), scope = await f.scope(), first = deferred(), nested = deferred(), dispatched = deferred(), provider = deferred();
  const send = scope.mutation('provider', () => { dispatched.resolve(); return provider.promise; }, response => response.ok);
  await scope.run(async () => {
    scope.waitUntil(first.promise.then(() => { scope.waitUntil(nested.promise); }));
    const operation = send();
    await dispatched.promise;
    assert.equal(await Promise.race([operation, Promise.resolve('deadline')]), 'deadline');
  });
  await f.close();
  assert.equal((await f.core.ready(maintenance, 1)).state, 'draining');
  first.resolve(); provider.resolve({ ok: true });
  await first.promise;
  assert.equal((await f.core.ready(maintenance, 1)).state, 'draining');
  nested.resolve();
  assert.deepEqual(await scope.done, { status: 'released' });
  assert.equal((await f.core.ready(maintenance, 1)).state, 'closed');
  assert.throws(() => send(), /revoked/);
  assert.throws(() => scope.waitUntil(Promise.resolve()), /revoked/);
});

test('caught provider failure stays blocking; trusted exact readback never releases an orphan', async t => {
  const f = await fixture(t), scope = await f.scope();
  const send = scope.mutation('provider', async () => { throw Error('timeout after dispatch'); }, () => true);
  await scope.run(async () => { try { await send(); } catch { /* Application catches the error. */ } });
  assert.deepEqual(await scope.done, { status: 'blocked' });
  await f.close();
  const operation = f.one.prepare('SELECT operation_id AS operationId FROM updater_execution_operations').get();
  f.controls.resolve = async context => ({ ...context, operationId: 'wrong', outcome: 'complete' });
  assert.equal((await f.core.reconcileOperation(maintenance, { permitId: scope.permitId, ...operation })).status, 'unknown');
  f.controls.resolve = async context => ({ ...context, outcome: 'complete' });
  assert.equal((await f.core.reconcileOperation(maintenance, { permitId: scope.permitId, ...operation })).status, 'complete');
  assert.equal((await f.core.ready(maintenance, 1)).state, 'draining');
  assert.deepEqual(await scope.retryRelease(), { status: 'released' });
  assert.equal((await f.core.ready(maintenance, 1)).state, 'closed');
});

test('scoped real SQL and service callbacks revoke before release; app replacement cannot reopen maintenance', async t => {
  const f = await fixture(t), scope = await f.scope();
  const queriesAfterAdmission = f.controls.queries;
  const native = { prepare(sql) { return { bind(...args) { return { async run() { f.app.prepare(sql).run(...args); return { success: true }; } }; } }; } };
  const db = scope.wrapD1(native), statement = db.prepare('INSERT INTO data VALUES(?)').bind('synthetic');
  let calls = 0;
  const service = scope.wrapService({ fetch: async () => { calls++; return { ok: true }; } }, result => result.ok);
  const callback = scope.guard(async () => 'read-only');
  await scope.run(async () => { await statement.run(); await service.fetch(); await callback(); });
  assert.equal((await scope.done).status, 'released');
  assert.equal(f.controls.queries - queriesAfterAdmission, 1, 'normal calls add no updater SQL; only final release');
  assert.equal(f.one.prepare('SELECT count(*) AS n FROM updater_execution_operations').get().n, 0);
  assert.equal(f.app.prepare('SELECT count(*) AS count FROM data').get().count, 1);
  assert.throws(() => statement.run(), /revoked/);
  assert.throws(() => db.prepare('DELETE FROM data'), /revoked/);
  assert.throws(() => service.fetch(), /revoked/);
  assert.throws(() => callback(), /revoked/);
  assert.equal(calls, 1);
  await f.close(); await f.core.ready(maintenance, 1);
  f.app.exec('DROP TABLE data; CREATE TABLE restored(value TEXT);');
  assert.equal((await f.other.ready(maintenance, 1)).state, 'closed');
  assert.equal((await f.other.admit(execution, { permitId: id() })).status, 'not-admitted');
});

test('lost ambiguity persistence cannot release; handler error still waits for tracked diagnostics', async t => {
  const f = await fixture(t), scope = await f.scope(), diagnostics = deferred();
  let dispatched = false;
  f.controls.lose = sql => sql.startsWith('INSERT INTO updater_execution_operations');
  const send = scope.mutation('provider', async () => { dispatched = true; throw Error('provider-unknown'); }, () => true);
  await assert.rejects(scope.run(async () => {
    scope.waitUntil(diagnostics.promise);
    await send();
  }), /provider-unknown/);
  await f.close();
  assert.equal((await f.core.ready(maintenance, 1)).state, 'draining');
  diagnostics.resolve();
  assert.equal((await scope.done).status, 'blocked');
  assert.equal(dispatched, true);
  assert.equal((await scope.retryRelease()).status, 'blocked');
  const pendingPlan = f.one.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM updater_execution_operations WHERE permit_id=? AND state='pending'").all(scope.permitId);
  assert.match(JSON.stringify(pendingPlan), /updater_pending_operations/);
});

test('failed ambiguity write stays locally blocking and can later record one bounded readback identity', async t => {
  const f = await fixture(t), scope = await f.scope();
  let dispatchedOperation;
  f.controls.fail = sql => sql.startsWith('INSERT INTO updater_execution_operations');
  const send = scope.mutation('provider', async operation => { dispatchedOperation = operation; throw Error('unknown'); });
  await scope.run(async () => { await send().catch(() => {}); });
  assert.equal((await scope.done).status, 'blocked');
  assert.equal(f.one.prepare('SELECT count(*) AS n FROM updater_execution_operations').get().n, 0);
  await f.close();
  assert.equal((await f.core.ready(maintenance, 1)).state, 'draining');
  assert.equal((await scope.retryRelease()).status, 'blocked');
  f.controls.resolve = async operation => ({ ...operation, outcome: 'complete' });
  await f.core.reconcileOperation(maintenance, { permitId: scope.permitId, operationId: dispatchedOperation.operationId });
  assert.equal((await scope.retryRelease()).status, 'released');
});
