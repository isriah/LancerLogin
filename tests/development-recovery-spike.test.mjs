import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { REPOSITORY, DATABASE, SQL, runJob, recoverySpike, parseRecoveryArgs, boundedBytes, syntheticImportBytes } from "../scripts/development-recovery-spike.mjs";

const account = "a".repeat(32);
const id = "11111111-1111-1111-1111-111111111111";
const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "cfat_synthetic" };
const options = (mode) => ({ mode, repository: REPOSITORY, expectedAccountId: account, expectedDatabaseId: id });
function sqlite() {
  const db = new DatabaseSync(":memory:");
  const query = async (sql, params = []) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
  return { db, query };
}
async function initialized() {
  const local = sqlite();
  for (const sql of SQL.schema) await local.query(sql);
  return local;
}
function fixture() {
  const { db, query } = sqlite();
  const files = new Map();
  const calls = [];
  let exists = false;
  let snapshot;
  const storage = {
    read: async (name) => files.has(name) ? structuredClone(files.get(name)) : undefined,
    async save(name, value, exclusive) { if (exclusive && files.has(name)) throw Error("exists"); files.set(name, structuredClone(value)); },
    async bytes(name, bytes) { if (files.has(name)) throw Error("exists"); files.set(name, Buffer.from(bytes)); },
    loadBytes: async (name) => files.get(name),
  };
  let exportCalls = 0;
  let uploaded;
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    calls.push({ url, init });
    const ok = (result) => Response.json({ success: true, result });
    if (target.hostname === "synthetic.r2.cloudflarestorage.com") {
      if (init.method === "PUT") {
        assert.deepEqual(Object.keys(init.headers), ["content-length"]);
        assert.equal(init.redirect, "error");
        uploaded = Buffer.from(init.body);
        return new Response(null, { headers: { etag: `"${createHash("md5").update(uploaded).digest("hex")}"` } });
      }
      assert.equal(init.headers, undefined);
      const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((row) => row.sql);
      const records = db.prepare("SELECT id,value FROM recovery_fixture ORDER BY id").all().map((row) => `INSERT INTO recovery_fixture VALUES('${row.id}','${row.value}')`);
      const job = db.prepare("SELECT * FROM recovery_job").get();
      return new Response([...schema, ...records, `INSERT INTO recovery_job VALUES(1,${job.checkpoint},'${job.status}',NULL,0)`].join(";\n") + ";\n");
    }
    assert.equal(target.origin, "https://api.cloudflare.com");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer cfat_synthetic");
    const path = target.pathname.replace(`/client/v4/accounts/${account}/`, "");
    if (path === "tokens/verify") return ok({ status: "active" });
    if (path === "d1/database" && init.method === "GET") return ok(exists ? [{ uuid: id, name: DATABASE }] : []);
    if (path === "d1/database" && init.method === "POST") { exists = true; return ok({ uuid: id, name: DATABASE }); }
    if (path === `d1/database/${id}`) return ok({ uuid: id, name: DATABASE });
    if (path.endsWith("/query")) {
      const { sql, params } = JSON.parse(init.body);
      try { return ok([{ success: true, results: await query(sql, params) }]); }
      catch { return Response.json({ success: false, errors: [{ message: "PRIVATE PROVIDER DIAGNOSTIC" }] }); }
    }
    if (path.endsWith("/time_travel/bookmark")) {
      snapshot = { data: await query(SQL.data), job: db.prepare("SELECT * FROM recovery_job").get() };
      return ok({ bookmark: "synthetic-bookmark" });
    }
    if (path.endsWith("/export")) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.dump_options.tables, ["recovery_fixture", "recovery_job"]);
      if (!exportCalls++) return ok({ at_bookmark: "export-bookmark" });
      assert.equal(body.current_bookmark, "export-bookmark");
      return ok({ status: "complete", result: { signed_url: "https://synthetic.r2.cloudflarestorage.com/export?private=signature" } });
    }
    if (path.endsWith("/time_travel/restore")) {
      assert.equal(init.method, "POST");
      assert.equal(target.searchParams.get("bookmark"), "synthetic-bookmark");
      db.exec("DELETE FROM recovery_fixture");
      for (const row of snapshot.data) db.prepare("INSERT INTO recovery_fixture VALUES (?,?)").run(row.id, row.value);
      return ok({ bookmark: "new-bookmark", previous_bookmark: "undo-bookmark" });
    }
    if (path.endsWith("/import")) {
      const body = JSON.parse(init.body);
      if (body.action === "init") return ok({ filename: "synthetic.sql", upload_url: "https://synthetic.r2.cloudflarestorage.com/import?private=signature" });
      if (body.action === "ingest") {
        assert.equal(body.filename, "synthetic.sql");
        assert.equal(body.etag, createHash("md5").update(uploaded).digest("hex"));
        db.exec(uploaded.toString("utf8"));
        return ok({ at_bookmark: "import-bookmark" });
      }
      assert.equal(body.action, "poll");
      assert.equal(body.current_bookmark, "import-bookmark");
      return ok({ status: "complete", result: { final_bookmark: "import-final" } });
    }
    assert.fail(`Unexpected mock path ${path}`);
  };
  return { db, files, calls, storage, fetchImpl, env, sleep: async () => {}, query };
}

test("SQLite durable interruption rejects a contender and resumes without duplicate writes", async () => {
  const { db, query } = await initialized();
  const interrupted = await runJob(query, "interrupt", "owner-a");
  assert.equal(interrupted.concurrentLockRejected, true);
  await assert.rejects(runJob(query, "resume", "owner-b"), /Concurrent/);
  assert.deepEqual(await query(SQL.job), [{ checkpoint: 1, status: "interrupted" }]);
  db.exec("UPDATE recovery_job SET lease_until=0"); // Simulates expiry; no production clock override.
  assert.equal((await runJob(query, "resume", "owner-b")).syntheticRows, 2);
  assert.equal((await runJob(query, "resume", "owner-c")).syntheticRows, 2);
  db.close();
});

test("SQLite rejects invalid migration and retains a recoverable checkpoint", async () => {
  const { db, query } = await initialized();
  await runJob(query, "resume");
  const result = await runJob(query, "fail-migration");
  assert.equal(result.status, "migration-failed-recoverable");
  assert.deepEqual(await query(SQL.job), [{ checkpoint: 2, status: "migration-failed-recoverable" }]);
  assert.equal((await query(SQL.data)).length, 2);
  assert.equal((await query(SQL.tables)).length, 2);
  db.close();
});

test("expired or superseded owner cannot write data or checkpoint", async () => {
  const { db, query } = await initialized();
  await query(SQL.claim, ["owner-a"]);
  await query(SQL.first, ["owner-b"]);
  assert.equal((await query(SQL.data)).length, 0);
  db.exec("UPDATE recovery_job SET lease_until=0");
  assert.deepEqual(await query(SQL.checkpoint, [1, "interrupted", "owner-a"]), []);
  await query(SQL.claim, ["owner-b"]);
  await query(SQL.release, ["owner-a"]);
  assert.equal(db.prepare("SELECT owner FROM recovery_job").get().owner, "owner-b");
  db.close();
});

test("mock Cloudflare lifecycle saves digest, uses polling and exact restore bookmark", async () => {
  const f = fixture();
  await recoverySpike(options("create"), f);
  await recoverySpike(options("initialize"), f);
  await recoverySpike(options("interrupt"), f);
  f.db.exec("UPDATE recovery_job SET lease_until=0");
  await recoverySpike(options("resume"), f);
  await recoverySpike(options("fail-migration"), f);
  const backup = await recoverySpike(options("backup"), f);
  assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.files.get("backup.json").bookmark, "synthetic-bookmark");
  await recoverySpike(options("damage"), f);
  assert.equal((await f.query(SQL.data)).length, 3);
  assert.equal((await recoverySpike(options("restore"), f)).status, "restored-and-verified");
  await recoverySpike(options("restore"), f);
  assert.equal(f.calls.filter(({ url }) => url.includes("/time_travel/restore?")).length, 1);
  assert.equal(f.files.get("restore-response.json").previousBookmark, "undo-bookmark");
  assert.equal(JSON.stringify(backup).includes("signature"), false);
  f.db.close();
});

test("wrong repo/account/database and origin identities fail closed before data writes", async () => {
  const f = fixture();
  await assert.rejects(recoverySpike({ ...options("create"), repository: "isriah/LancerLogin" }, f), /repository/);
  await assert.rejects(recoverySpike({ ...options("create"), expectedAccountId: "b".repeat(32) }, f), /account/);
  assert.equal(f.calls.length, 0);
  await recoverySpike(options("create"), f);
  await assert.rejects(recoverySpike({ ...options("initialize"), expectedDatabaseId: "22222222-2222-2222-2222-222222222222" }, f), /identity/);
  assert.equal(f.calls.some(({ url }) => url.endsWith("/query")), false);
  await assert.rejects(recoverySpike(options("create"), f), /already exists/);
  f.db.close();
});

test("foreign tables and tampered export prohibit restore", async () => {
  const f = fixture();
  await recoverySpike(options("create"), f);
  await recoverySpike(options("initialize"), f);
  f.db.exec("CREATE TABLE unrelated (id INTEGER)");
  await assert.rejects(recoverySpike(options("resume"), f), /Unexpected tables/);
  f.db.exec("DROP TABLE unrelated");
  await recoverySpike(options("resume"), f);
  await recoverySpike(options("fail-migration"), f);
  await recoverySpike(options("backup"), f);
  f.files.set("backup.sql", Buffer.from("tampered"));
  await assert.rejects(recoverySpike(options("damage"), f), /digest mismatch/);
  assert.equal(f.calls.some(({ url }) => url.includes("/time_travel/restore?")), false);
  f.db.close();
});

test("provider failures are sanitized and response streams are bounded", async () => {
  const f = fixture();
  await assert.rejects(recoverySpike(options("create"), { ...f, fetchImpl: async () => { throw Error("private token secret"); } }), (error) => !error.message.includes("secret") && /Cloudflare/.test(error.message));
  await assert.rejects(boundedBytes(new Response("12345"), 4), /limit/);
  assert.equal((await boundedBytes(new Response("1234"), 4)).length, 4);
  f.db.close();
});

test("CLI cannot supply SQL, paths, resource names or duplicate flags", () => {
  assert.throws(() => parseRecoveryArgs(["restore", "--url", "https://example.com"]), /Unsupported/);
  assert.throws(() => parseRecoveryArgs(["restore", "--repository", REPOSITORY, "--repository", REPOSITORY]), /duplicate/);
  assert.deepEqual(parseRecoveryArgs(["status", "--repository", REPOSITORY]), { mode: "status", repository: REPOSITORY });
});

test("an ambiguous restore retains its checkpoint and retries the identical bookmark", async () => {
  const f = fixture();
  for (const mode of ["create", "initialize", "resume", "fail-migration", "backup", "damage"]) await recoverySpike(options(mode), f);
  let dropped = false;
  const uncertain = { ...f, fetchImpl: async (url, init) => {
    const result = await f.fetchImpl(url, init);
    if (url.includes("/time_travel/restore?") && !dropped) { dropped = true; throw Error("connection lost after successful operation"); }
    return result;
  } };
  await assert.rejects(recoverySpike(options("restore"), uncertain), /Cloudflare operation failed/);
  assert.equal(f.files.get("backup.json").phase, "restore-pending");
  assert.equal((await recoverySpike(options("restore"), f)).status, "restored-and-verified");
  const restores = f.calls.filter(({ url }) => url.includes("/time_travel/restore?"));
  assert.equal(restores.length, 2);
  assert.equal(restores[0].url, restores[1].url);
  f.db.close();
});

test("export URLs cannot redirect credentials or target unapproved hosts", async () => {
  const f = fixture();
  for (const mode of ["create", "initialize", "resume", "fail-migration"]) await recoverySpike(options(mode), f);
  for (const signed_url of ["https://example.com/private", "http://synthetic.r2.cloudflarestorage.com/file", "https://user:secret@synthetic.r2.cloudflarestorage.com/file", "https://synthetic.r2.cloudflarestorage.com.evil.example/file"]) {
    const unsafe = { ...f, fetchImpl: async (url, init) => url.endsWith("/export")
      ? Response.json({ success: true, result: { status: "complete", result: { signed_url } } })
      : f.fetchImpl(url, init) };
    await assert.rejects(recoverySpike(options("backup"), unsafe), /Export host requires review/);
  }
  assert.equal(f.files.has("backup.sql"), false);
  f.db.close();
});

test("same-name remote collisions and wrong live resource names prohibit mutation", async () => {
  const f = fixture();
  const collision = { ...f, fetchImpl: async (url, init) => url.includes("d1/database?page=")
    ? Response.json({ success: true, result: [{ uuid: id, name: DATABASE }] }) : f.fetchImpl(url, init) };
  await assert.rejects(recoverySpike(options("create"), collision), /collision/);
  assert.equal(f.calls.some(({ init }) => init.method === "POST"), false);
  await recoverySpike(options("create"), f);
  const wrongName = { ...f, fetchImpl: async (url, init) => url.endsWith(`/d1/database/${id}`)
    ? Response.json({ success: true, result: { uuid: id, name: "lancerlogin-v2-example-data" } }) : f.fetchImpl(url, init) };
  await assert.rejects(recoverySpike(options("initialize"), wrongName), /identity mismatch/);
  assert.equal(f.calls.some(({ url }) => url.endsWith("/query")), false);
  f.db.close();
});

async function importReady() {
  const f = fixture();
  for (const mode of ['create', 'initialize', 'resume', 'fail-migration', 'backup', 'damage', 'restore']) await recoverySpike(options(mode), f);
  return f;
}
const importCalls = (f, action) => f.calls.filter(({ url, init }) => url.endsWith('/import') && JSON.parse(init.body).action === action);

test('SQL import restores actual SQLite schema and rows through mocked upload/ingest/poll', async () => {
  const f = await importReady();
  const result = await recoverySpike(options('sql-import'), f);
  assert.equal(result.status, 'imported-and-verified');
  assert.equal(result.syntheticRows, 2);
  assert.equal(result.reconciled, false);
  assert.equal(f.files.get('import.json').phase, 'complete');
  assert.equal(f.files.get('import.json').uploadUrl, undefined);
  assert.deepEqual(await f.query(SQL.job), [{ checkpoint: 2, status: 'migration-failed-recoverable' }]);
  await recoverySpike(options('sql-import'), f);
  assert.equal(importCalls(f, 'init').length, 1);
  assert.equal(importCalls(f, 'ingest').length, 1);
  assert.equal(JSON.stringify(result).includes('signature'), false);
  f.db.close();
});

test('strict export grammar rejects extra SQL, altered schema, duplicates and missing rows', async () => {
  const f = await importReady();
  const good = f.files.get('backup.sql').toString();
  for (const sql of [good + 'DROP TABLE unrelated;', good.replace('baseline', 'changed'), good.replace('NOT NULL', ''), good + SQL.schema[0] + ';', good.replace(/INSERT INTO recovery_fixture[^;]+;/, '')]) {
    assert.throws(() => syntheticImportBytes(Buffer.from(sql)), /synthetic|Synthetic/);
  }
  assert.throws(() => syntheticImportBytes(Buffer.alloc(1024 * 1024 + 1)), /size/);
  // Common D1 quote and pragma envelope accepted; output remains canonical.
  assert.deepEqual(syntheticImportBytes(Buffer.from('PRAGMA defer_foreign_keys=TRUE;\n' + good.replaceAll('recovery_fixture', '"recovery_fixture"'))), syntheticImportBytes(Buffer.from(good)));
  f.db.close();
});

test('observed explicit-column D1 export reconstructs only fixed ordered synthetic records', () => {
  const dump = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE recovery_fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO "recovery_fixture" ("id","value") VALUES('synthetic-1','baseline');
INSERT INTO "recovery_fixture" ("id","value") VALUES('synthetic-2','resumed');
CREATE TABLE recovery_job (id INTEGER PRIMARY KEY CHECK(id=1), checkpoint INTEGER NOT NULL, status TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL);
INSERT INTO "recovery_job" ("id","checkpoint","status","owner","lease_until") VALUES(1,2,'migration-failed-recoverable',NULL,0);`;
  const canonical = syntheticImportBytes(Buffer.from(dump));
  const implicit = dump.replaceAll(' ("id","value")', '').replace(' ("id","checkpoint","status","owner","lease_until")', '');
  assert.deepEqual(canonical, syntheticImportBytes(Buffer.from(implicit)));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(canonical.toString());
    assert.deepEqual(db.prepare('SELECT id,value FROM recovery_fixture ORDER BY id').all().map(row => ({...row})), [{id:'synthetic-1',value:'baseline'},{id:'synthetic-2',value:'resumed'}]);
    assert.deepEqual({...db.prepare('SELECT * FROM recovery_job').get()}, {id:1,checkpoint:2,status:'migration-failed-recoverable',owner:null,lease_until:0});
  } finally { db.close(); }
  for (const invalid of [
    dump.replace('("id","value")', '("value","id")'),
    dump.replace('"checkpoint","status"', '"status","checkpoint"'),
    dump.replace('("id","value")', '("id","unknown")'),
    dump.replace('("id","value")', '("id","id")'),
    dump.replace("VALUES('synthetic-1','baseline')", "VALUES('synthetic-1',upper('baseline'))"),
    dump + "INSERT INTO recovery_fixture VALUES('synthetic-1','baseline');",
    dump + 'INSERT INTO "recovery_job" ("id","checkpoint","status","owner","lease_until") VALUES(1,2,\'migration-failed-recoverable\',NULL,0);',
    dump + 'DROP TABLE unrelated;',
  ]) assert.throws(() => syntheticImportBytes(Buffer.from(invalid)), /synthetic|Synthetic/);
});

test('import rejects tampered backup, wrong destination and unexpected triggers before mutation', async () => {
  for (const change of ['digest', 'id', 'trigger']) {
    const f = await importReady();
    if (change === 'digest') f.files.set('backup.sql', Buffer.from('tampered'));
    if (change === 'id') f.files.get('backup.json').databaseId = '22222222-2222-2222-2222-222222222222';
    if (change === 'trigger') f.db.exec('CREATE TRIGGER foreign_trigger AFTER INSERT ON recovery_fixture BEGIN SELECT 1; END');
    const prior = f.calls.length;
    await assert.rejects(recoverySpike(options('sql-import'), f), /digest|backup|schema objects/);
    assert.equal(f.calls.slice(prior).some(({ url, init }) => url.endsWith('/import') || (url.endsWith('/query') && JSON.parse(init.body).sql === SQL.damage)), false);
    f.db.close();
  }
});

test('upload host pin rejects foreign, redirect and credential destinations without forwarding credentials', async () => {
  for (const upload_url of ['https://other.r2.cloudflarestorage.com/file', 'http://synthetic.r2.cloudflarestorage.com/file', 'https://user:secret@synthetic.r2.cloudflarestorage.com/file', 'https://example.com/file']) {
    const f = await importReady();
    const unsafe = { ...f, fetchImpl: (url, init) => url.endsWith('/import') ? Response.json({ success: true, result: { filename: 'synthetic.sql', upload_url } }) : f.fetchImpl(url, init) };
    await assert.rejects(recoverySpike(options('sql-import'), unsafe), /host|Host/);
    assert.equal(f.files.get('import.json').phase, 'init-pending');
    assert.equal(f.calls.some(({ init }) => init.method === 'PUT'), false);
    f.db.close();
  }
  const f = await importReady();
  const redirected = { ...f, fetchImpl: (url, init) => init?.method === 'PUT' ? Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://example.com' } })) : f.fetchImpl(url, init) };
  await assert.rejects(recoverySpike(options('sql-import'), redirected), /upload failed/);
  assert.equal(f.files.get('import.json').phase, 'upload');
  assert.equal(importCalls(f, 'ingest').length, 0);
  f.db.close();
});

test('uncertain init never blindly repeats; uncertain successful ingest reconciles without reingest', async () => {
  for (const action of ['init', 'ingest']) {
    const f = await importReady();
    const uncertain = { ...f, fetchImpl: async (url, init) => {
      const response = await f.fetchImpl(url, init);
      if (url.endsWith('/import') && JSON.parse(init.body).action === action) throw Error('PRIVATE token and signed URL');
      return response;
    } };
    await assert.rejects(recoverySpike(options('sql-import'), uncertain), (error) => /Cloudflare/.test(error.message) && !/PRIVATE|token|signed/.test(error.message));
    assert.equal(f.files.get('import.json').phase, action + '-pending');
    if (action === 'init') await assert.rejects(recoverySpike(options('sql-import'), f), /uncertain/);
    else assert.equal((await recoverySpike(options('sql-import'), f)).reconciled, true);
    assert.equal(importCalls(f, action).length, 1);
    f.db.close();
  }
});

test('upload failure retains a retryable stage and verifies response ETag', async () => {
  const f = await importReady();
  const bad = { ...f, fetchImpl: (url, init) => init?.method === 'PUT' ? Promise.resolve(new Response(null, { headers: { etag: 'wrong' } })) : f.fetchImpl(url, init) };
  await assert.rejects(recoverySpike(options('sql-import'), bad), /upload failed/);
  assert.equal(f.files.get('import.json').phase, 'upload');
  assert.equal((await recoverySpike(options('sql-import'), f)).status, 'imported-and-verified');
  assert.equal(importCalls(f, 'init').length, 1);
  f.db.close();
});

test('bounded polling resumes the saved bookmark and provider errors prohibit restart', async () => {
  const f = await importReady();
  let polls = 0;
  const waiting = { ...f, fetchImpl: (url, init) => {
    if (url.endsWith('/import') && JSON.parse(init.body).action === 'poll') { polls++; return Promise.resolve(Response.json({ success: true, result: { at_bookmark: 'import-bookmark' } })); }
    return f.fetchImpl(url, init);
  } };
  await assert.rejects(recoverySpike(options('sql-import'), waiting), /polling limit/);
  assert.equal(polls, 30);
  assert.equal(f.files.get('import.json').phase, 'poll');
  assert.equal((await recoverySpike(options('sql-import'), f)).status, 'imported-and-verified');
  assert.equal(importCalls(f, 'ingest').length, 1);
  f.db.close();
  const g = await importReady();
  const failed = { ...g, fetchImpl: (url, init) => url.endsWith('/import') && JSON.parse(init.body).action === 'ingest'
    ? Promise.resolve(Response.json({ success: true, result: { status: 'error', error: 'PRIVATE PROVIDER TEXT' } })) : g.fetchImpl(url, init) };
  await assert.rejects(recoverySpike(options('sql-import'), failed), /Provider import failed/);
  assert.equal(g.files.get('import.json').phase, 'failed');
  await assert.rejects(recoverySpike(options('sql-import'), g), /automatic restart prohibited/);
  g.db.close();
});

test('poll transport timeout keeps bookmark; init cached completion is verified without another ingest', async () => {
  const f = await importReady();
  const timed = { ...f, fetchImpl: (url, init) => {
    if (url.endsWith('/import') && JSON.parse(init.body).action === 'poll') return Promise.reject(new DOMException('PRIVATE network URL', 'TimeoutError'));
    return f.fetchImpl(url, init);
  } };
  await assert.rejects(recoverySpike(options('sql-import'), timed), /Cloudflare operation failed/);
  assert.equal(f.files.get('import.json').bookmark, 'import-bookmark');
  assert.equal((await recoverySpike(options('sql-import'), f)).status, 'imported-and-verified');
  assert.equal(importCalls(f, 'ingest').length, 1);
  f.db.close();
  const g = await importReady();
  const cached = { ...g, fetchImpl: (url, init) => {
    if (url.endsWith('/import') && JSON.parse(init.body).action === 'init') {
      g.db.exec(syntheticImportBytes(g.files.get('backup.sql')).toString());
      return Promise.resolve(Response.json({ success: true, result: { status: 'complete' } }));
    }
    return g.fetchImpl(url, init);
  } };
  assert.equal((await recoverySpike(options('sql-import'), cached)).status, 'imported-and-verified');
  assert.equal(importCalls(g, 'ingest').length, 0);
  g.db.close();
});

test('saved upload checkpoint rejects tampered destination and new nonfixture records', async () => {
  for (const mutation of ['host', 'row', 'filename']) {
    const f = await importReady();
    const stopped = { ...f, fetchImpl: (url, init) => init?.method === 'PUT' ? Promise.reject(Error('unavailable')) : f.fetchImpl(url, init) };
    await assert.rejects(recoverySpike(options('sql-import'), stopped), /upload failed/);
    const state = f.files.get('import.json');
    if (mutation === 'host') state.uploadUrl = 'https://other.r2.cloudflarestorage.com/file';
    if (mutation === 'filename') state.filename = '../unapproved.sql';
    if (mutation === 'row') f.db.exec("INSERT INTO recovery_fixture VALUES('unexpected','out-of-scope')");
    await assert.rejects(recoverySpike(options('sql-import'), f), /destination mismatch|Synthetic data/);
    assert.equal(importCalls(f, 'ingest').length, 0);
    f.db.close();
  }
});
