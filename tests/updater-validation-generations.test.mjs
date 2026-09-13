import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createArtifactStore } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createSnapshotCapture } from '../apps/updater/src/snapshot-capture.mjs';
import { createSnapshotReplay } from '../apps/updater/src/snapshot-replay.mjs';
import { selectSnapshotCatalog } from '../apps/updater/src/snapshot-catalog-registry.mjs';

test('completed46 target adopts and reuses for49; historical proof survives bounded cleanup and lost acknowledgments', async t => {
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic")}}',compatibilityDate:'2026-08-01',d1Databases:['SOURCE46','SOURCE49','TARGET']}));t.after(()=>mf.dispose());
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql',import.meta.url),'utf8'));
  let statements=0,maxStatements=0,hook=null,batches=0;
  const state={prepare(sql){let params=[];return{bind(...p){params=p;return this;},async first(){statements++;return sqlite.prepare(sql).get(...params)??null;},async all(){statements++;return{results:sqlite.prepare(sql).all(...params)};}};}};
  const installationId='synthetic-generations',store=createArtifactStore({database:state,installationId,cipher:await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)),installationId)});
  const pins={installationId,applicationDatabaseId:'11111111-1111-4111-8111-111111111111',updaterDatabaseId:'22222222-2222-4222-8222-222222222222',validationDatabaseId:'33333333-3333-4333-8333-333333333333'};
  const target=await mf.getD1Database('TARGET');
  const database={withSession(mode){assert.equal(mode,'first-primary');return this;},prepare(sql){statements++;return target.prepare(sql);},async batch(sql){batches++;if(hook)return hook(sql);return target.batch(sql);}};
  async function source(schema,epoch){
    const catalogKey=`schema-${schema}-v1`,{catalog}=selectSnapshotCatalog(catalogKey),db=await mf.getD1Database(`SOURCE${schema}`);
    const objects=[...catalog.objects.filter(o=>o.type==='table'&&o.name!=='sqlite_sequence'),...catalog.objects.filter(o=>o.type!=='table'&&o.sql)];
    for(let i=0;i<objects.length;i+=20)await db.batch(objects.slice(i,i+20).map(o=>db.prepare(o.sql)));
    await db.batch(catalog.ledger.map(entry=>db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(entry.id)));
    await db.batch([db.prepare("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026','local')"),db.prepare("INSERT INTO members(id,installation_id,external_id,first_name,last_name,created_at) VALUES('member','primary','1','Synthetic','Member','2026')"),db.prepare("INSERT INTO users(id,installation_id,local_username,created_at,member_id,role) VALUES('user','primary','synthetic','2026','member','admin')"),db.prepare("INSERT INTO platform_module_grants(installation_id,user_id) VALUES('primary','user')")]);
    const operationId=crypto.randomUUID(),authority={installationId,operationId,jobId:crypto.randomUUID(),epoch,state:'closed',schema,ledger:catalog.ledger};
    const {validationDatabaseId,...capturePins}=pins;
    const capture=createSnapshotCapture({pins:capturePins,database:db,store,catalogKey,withClosedEpoch:async(_,run)=>run(authority)});
    let result;for(let i=0;i<400;i++){result=await capture.advance(operationId);if(result.outcome==='snapshot-candidate')break;}assert.equal(result.outcome,'snapshot-candidate');
    const capability={},replay=createSnapshotReplay({pins,database,store,capture,capability,catalogKey,withClosedEpoch:async(_,run)=>run(authority)});
    return{operationId,authority,capture,replay,async advance(){statements=0;const r=await replay.advance(capability,{operationId,snapshotId:operationId});maxStatements=Math.max(statements,maxStatements);assert.ok(statements<=50,`statements ${statements}`);return r;},async reconcile(){return replay.reconcile(capability,{operationId,snapshotId:operationId});}};
  }
  async function finish(f){for(let i=0;i<700;i++){const result=await f.advance();if(result.outcome==='validated')return result;assert.equal(result.outcome,'pending',JSON.stringify(result));}assert.fail('not completed');}
  const first=await source(46,1),proof=await finish(first),retained=await first.capture.describe(first.operationId);
  assert.equal(proof.receipt.schema,46);
  // Simulate a completed pre-generation target. Its encrypted completion remains intact.
  await target.prepare('DROP TABLE _ll_snapshot_generations').run();
  const second=await source(49,2);
  second.authority.epoch=1;assert.equal((await second.advance()).outcome,'unknown');second.authority.epoch=2;
  assert.equal((await second.advance()).outcome,'pending'); // encrypted adoption intent
  hook=async sql=>{await target.batch(sql);hook=null;throw Error('lost adoption acknowledgment');};
  assert.equal((await second.advance()).outcome,'unknown');let count=batches;
  assert.equal((await second.reconcile()).outcome,'pending');assert.equal(batches,count);
  assert.equal((await second.advance()).outcome,'pending');assert.equal(batches,count);
  hook=async sql=>{await target.batch(sql);hook=null;throw Error('lost takeover acknowledgment');};
  assert.equal((await second.advance()).outcome,'unknown');count=batches;
  assert.equal((await second.advance()).outcome,'pending');assert.equal(batches,count);
  // An unknown object blocks cleanup before any target mutation.
  await target.prepare('CREATE TABLE unexpected_table(id TEXT)').run();count=batches;
  assert.equal((await second.advance()).outcome,'rejected');assert.equal(batches,count);
  await target.prepare('DROP TABLE unexpected_table').run();
  // Retain an original delayed dispatch. Reconciliation cannot redispatch it.
  let delayed;hook=async sql=>{delayed=sql;hook=null;throw Error('original request delayed');};
  assert.equal((await second.advance()).outcome,'unknown');count=batches;
  for(let i=0;i<2;i++){assert.equal((await second.reconcile()).outcome,'unknown');assert.equal((await second.advance()).outcome,'unknown');}
  assert.equal(batches,count);
  await target.batch(delayed); // only the original request completes, not a retry
  assert.equal((await second.advance()).outcome,'pending');assert.equal(batches,count);
  hook=async sql=>{await target.batch(sql);hook=null;throw Error('lost cleanup acknowledgment');};
  assert.equal((await second.advance()).outcome,'unknown');count=batches;
  assert.equal((await second.advance()).outcome,'pending');assert.equal(batches,count);
  const next=await finish(second);assert.equal(next.receipt.schema,49);
  assert.deepEqual(await first.reconcile(),proof);assert.deepEqual(await first.capture.describe(first.operationId),retained);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM _ll_snapshot_generations').first()).n,2);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM platform_module_grants').first()).n,1);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first()).n,49);
  // A new job cannot reuse an uncertain generation, even with otherwise valid live authority.
  const third=crypto.randomUUID(),row=await store.operation(`snapshot-replay:${second.operationId}`);
  await store.replace(`snapshot-replay:${second.operationId}`,row.revision,{...row.value,cursor:{phase:'checks'}});
  const capability={},invalid=createSnapshotReplay({pins,database,store,capture:second.capture,capability,withClosedEpoch:async(_,run)=>run({...second.authority,operationId:third,epoch:3,jobId:crypto.randomUUID()})});
  const before=batches;assert.equal((await invalid.advance(capability,{operationId:third,snapshotId:second.operationId})).outcome,'unknown');assert.equal(batches,before);
  t.diagnostic(`Maximum combined statements per advance: ${maxStatements}`);
});
