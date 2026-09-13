import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createDatabaseExportTransport, EXPORT_MAX_BYTES } from '../apps/updater/src/database-export.mjs';

const response = result => Response.json({ success: true, result });
async function fixture(t, bytes = new TextEncoder().encode('-- opaque synthetic SQL\r\nSELECT 1;\n')) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql', import.meta.url), 'utf8'));
  let queries = 0;
  const database = { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async first() { queries++; return db.prepare(sql).get(...args) ?? null; }, async all() { queries++; return { results: db.prepare(sql).all(...args) }; } }; } };
  const store = createArtifactStore({ database, installationId: 'synthetic-export', cipher: await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)), 'synthetic-export') });
  const pins = { installationId: 'synthetic-export', accountId: 'a'.repeat(32), applicationDatabaseId: '11111111-1111-4111-8111-111111111111', updaterDatabaseId: '22222222-2222-4222-8222-222222222222', exportStorageHost: 'synthetic.r2.cloudflarestorage.com' };
  const controls = {}, calls = [], id = crypto.randomUUID(), token = 'synthetic-never-live-token';
  const signedUrl = `https://${pins.exportStorageHost}/synthetic.sql?synthetic-private-signature=value`;
  async function fetcher(url, options) {
    calls.push({ url, options }); assert.equal(options.redirect, 'manual');
    if (url.startsWith('https://api.cloudflare.com/')) {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(new URL(url).pathname, `/client/v4/accounts/${pins.accountId}/d1/database/${pins.applicationDatabaseId}/export`);
      const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body).sort(), body.current_bookmark ? ['current_bookmark', 'output_format'] : ['output_format']);
      if (controls.loseStart && !body.current_bookmark) throw Error('lost-start');
      if (controls.losePoll && body.current_bookmark) { controls.losePoll = false; throw Error('lost-poll'); }
      if (controls.providerRedirect) return new Response(null, { status: 302, headers: { location: signedUrl } });
      return response(body.current_bookmark ? { status: 'complete', at_bookmark: 'synthetic-bookmark', result: { signed_url: controls.badUrl ?? signedUrl } } : { at_bookmark: 'synthetic-bookmark' });
    }
    assert.deepEqual(options.headers, {}); assert.equal(options.method, 'GET');
    if (controls.downloadRedirect) return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/steal' } });
    if (controls.oversize) return new Response('small', { headers: { 'content-length': String(EXPORT_MAX_BYTES + 1) } });
    return new Response(controls.bytes ?? bytes);
  }
  const build = customStore => createDatabaseExportTransport({ pins, token, store: customStore ?? store, fetch: fetcher });
  return { db, store, pins, controls, calls, id, bytes, signedUrl, build, budget: () => { const result = queries + calls.length; queries = 0; calls.length = 0; return result; } };
}

test('original maximum-size SQL remains encrypted and resumes with a bounded complete query/request budget', async t => {
  const bytes = new Uint8Array(EXPORT_MAX_BYTES).fill(81); bytes.set(new TextEncoder().encode('-- synthetic original SQL\r\n'));
  const f = await fixture(t, bytes); let transport = f.build();
  assert.equal((await transport.begin(f.id)).outcome, 'pending');
  assert.equal((await transport.advance(f.id)).outcome, 'pending'); f.budget();
  let status;
  for (let i = 0; i < 25; i++) {
    transport = f.build(); status = await transport.advance(f.id);
    assert.ok(f.budget() <= 50, 'all store queries plus fetch requests fit the invocation budget');
    if (status.outcome === 'backup-candidate') break;
  }
  assert.equal(status.outcome, 'backup-candidate'); assert.equal(status.candidate.verified, false);
  assert.deepEqual((await f.build().read(f.id)).bytes, bytes);
  const persisted = JSON.stringify(f.db.prepare('SELECT envelope FROM updater_provider_operations').all()) + JSON.stringify(f.db.prepare('SELECT envelope FROM updater_artifact_chunks').all());
  assert.ok(!persisted.includes(f.signedUrl)); assert.ok(!persisted.includes('synthetic original SQL'));
  assert.ok(!JSON.stringify(status).includes('signed_url'));
});

test('initial lost acknowledgment never restarts; saved bookmark polls retry without changing identity', async t => {
  const f = await fixture(t); f.controls.loseStart = true;
  assert.equal((await f.build().begin(f.id)).outcome, 'unknown');
  assert.equal((await f.build().begin(f.id)).outcome, 'unknown');
  assert.equal((await f.build().advance(f.id)).outcome, 'unknown'); assert.equal(f.calls.length, 1);
  f.controls.loseStart = false; const second = crypto.randomUUID(); await f.build().begin(second);
  f.controls.losePoll = true; assert.equal((await f.build().advance(second)).outcome, 'unknown');
  assert.equal((await f.build().advance(second)).outcome, 'pending');
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { output_format: 'polling', current_bookmark: 'synthetic-bookmark' });
});

test('host, redirects, oversized bytes and database identity boundaries fail closed without credential forwarding', async t => {
  const f = await fixture(t); await f.build().begin(f.id);
  f.controls.badUrl = 'https://synthetic.r2.cloudflarestorage.com.evil.invalid/export';
  assert.equal((await f.build().advance(f.id)).outcome, 'unknown'); assert.equal(f.calls.length, 2);
  delete f.controls.badUrl; await f.build().advance(f.id);
  f.controls.downloadRedirect = true; assert.equal((await f.build().advance(f.id)).outcome, 'unknown');
  f.controls.downloadRedirect = false; f.controls.oversize = true; assert.equal((await f.build().advance(f.id)).outcome, 'unknown');
  assert.equal(await f.store.info(`database-export:${f.id}:sql`), null);
  f.controls.providerRedirect = true; assert.equal((await f.build().begin(crypto.randomUUID())).outcome, 'unknown');
  assert.throws(() => createDatabaseExportTransport({ pins: { ...f.pins, updaterDatabaseId: f.pins.applicationDatabaseId }, token: 'synthetic-test-token', store: f.store }));
});

test('lost chunk acknowledgment resumes original bytes; altered resumed download cannot replace frozen digest', async t => {
  const f = await fixture(t, new Uint8Array(1000000).fill(65)); await f.build().begin(f.id); await f.build().advance(f.id);
  let lost = true;
  const uncertain = { ...f.store, async writeChunk(...args) { await f.store.writeChunk(...args); if (lost) { lost = false; throw Error('lost-store-ack'); } } };
  assert.equal((await f.build(uncertain).advance(f.id)).outcome, 'unknown');
  f.controls.bytes = new Uint8Array(1000000).fill(66);
  assert.equal((await f.build().advance(f.id)).outcome, 'unknown');
  await assert.rejects(() => f.build().read(f.id), /incomplete/);
  delete f.controls.bytes;
  let status; for (let i = 0; i < 3; i++) { status = await f.build().advance(f.id); if (status.outcome === 'backup-candidate') break; }
  assert.equal(status.outcome, 'backup-candidate'); assert.deepEqual((await f.build().read(f.id)).bytes, f.bytes);
  const finalId = crypto.randomUUID(); await f.build().begin(finalId); await f.build().advance(finalId);
  const finalLost = { ...f.store, async writeChunk(...args) { await f.store.writeChunk(...args); if (args[1] === 10) throw Error('lost-final-chunk-ack'); } };
  await f.build(finalLost).advance(finalId);
  assert.equal((await f.build(finalLost).advance(finalId)).outcome, 'unknown');
  const requestsBeforeExpiry = f.calls.length; f.controls.downloadRedirect = true;
  assert.equal((await f.build().advance(finalId)).outcome, 'backup-candidate');
  assert.equal(f.calls.length, requestsBeforeExpiry, 'complete encrypted chunks seal without an expired URL download');
});
