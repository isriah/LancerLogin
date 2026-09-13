import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {migrationStatements} from './migration-statements.mjs';
import {selectSnapshotCatalog} from '../apps/updater/src/snapshot-catalog-registry.mjs';
import {createSnapshotCapture} from '../apps/updater/src/snapshot-capture.mjs';
import {createSnapshotReplay} from '../apps/updater/src/snapshot-replay.mjs';
import {createArtifactStore} from '../apps/updater/src/artifact-store.mjs';
import {createCheckpointCipher} from '../apps/updater/src/checkpoint.mjs';

test('compiled47/48 capture and isolated replay retain intermediate histories, claim pins and operational custody',{timeout:180000},async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){throw Error("No provider calls")}}',compatibilityDate:'2026-08-01',d1Databases:['SOURCE47','TARGET47','SOURCE48','TARGET48','WRONG']}));t.after(()=>mf.dispose());
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());sqlite.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql',import.meta.url),'utf8'));
 const database={prepare(sql){let args=[];return {bind(...values){args=values;return this;},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};}};
 const store=createArtifactStore({database,installationId:'synthetic',cipher:await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)),'synthetic')});
 const pins={installationId:'synthetic',applicationDatabaseId:'11111111-1111-4111-8111-111111111111',updaterDatabaseId:'22222222-2222-4222-8222-222222222222'};
 for(const schema of [47,48])await t.test('schema'+schema,async()=>{
  const key=`schema-${schema}-v1`,{catalog}=selectSnapshotCatalog(key),source=await mf.getD1Database('SOURCE'+schema),target=await mf.getD1Database('TARGET'+schema);
  for(const entry of catalog.ledger)await source.batch(migrationStatements(readFileSync(new URL('../apps/api/migrations/'+entry.id,import.meta.url),'utf8')).map(sql=>source.prepare(sql)));
  await source.prepare(catalog.objects.find(o=>o.name==='d1_migrations'&&o.type==='table').sql).run();await source.batch(catalog.ledger.map(entry=>source.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(entry.id)));
  const insert=(table,row)=>source.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  await insert('installations',{id:'primary',created_at:'2026',auth_mode:'local'});await insert('users',{id:'staff',installation_id:'primary',local_username:'synthetic',role:'admin',created_at:'2026'});
  const base={installation_id:'primary',title:'Synthetic original',caption:'Synthetic\u0000caption',url:'https://example.invalid/original',original_url:'https://example.invalid/original',created_at:'2026',file_id:'synthetic-file',file_root_id:'synthetic-root',file_generation:'synthetic-generation',file_sha256:'a'.repeat(64),file_size:10,file_mime:'application/octet-stream',validation_outcome:'linked-only',kind:'file'};
  await insert('documentation_artifacts',{...base,id:'file',revision:1,author_user_id:'staff',updated_at:'2026'});
  for(const revision of [0,1])await insert('documentation_artifact_revisions',{...base,artifact_id:'file',revision,actor_user_id:'staff'});
  await insert('documentation_definitions',{installation_id:'primary',id:'definition',title:'Synthetic definition',definition:'Synthetic',source:'',archived:0,revision:0,author_user_id:'staff',created_at:'2026',updated_at:'2026'});
  // Fixed INSERT lists preserve the definition/claim schema's existing field names.
  await source.prepare("INSERT INTO documentation_definition_revisions VALUES('primary','definition',0,'staff','Synthetic definition','Synthetic','',0,'2026')").run();
  await source.prepare("INSERT INTO documentation_claims VALUES('primary','claim','Synthetic claim','definition',0,'2026-01-01','2026-01-02','Synthetic rationale',0,NULL,NULL,NULL,NULL,0,'staff','2026','2026')").run();
  await source.prepare("INSERT INTO documentation_claim_revisions VALUES('primary','claim',0,'staff','Synthetic claim','definition',0,'2026-01-01','2026-01-02','Synthetic rationale',0,NULL,NULL,NULL,NULL,'2026')").run();
  await source.prepare("INSERT INTO documentation_claim_revision_artifacts VALUES('primary','claim',0,'file',0)").run();
  await insert('documentation_upload_operations',{installation_id:'primary',id:'upload',source:'staff',author_user_id:'staff',request_hash:'b'.repeat(64),key_hash:'c'.repeat(64),ticket_hash:'d'.repeat(64),ticket_expires_ms:42,title:'Synthetic upload',caption:'',mime:base.file_mime,byte_length:10,sha256:base.file_sha256,activities_json:'[]',initiatives_json:'[]',section_revision:0,root_id:base.file_root_id,root_revision:1,connection_generation:base.file_generation,connection_iv:'synthetic-iv',compute_id:'synthetic-compute',manifest_json:'{}',snapshot_digest:'e'.repeat(64),state:'saved',file_id:base.file_id,dispatched:1,session_ciphertext:'synthetic-encrypted-custody',session_iv:'synthetic-iv',artifact_id:'file',created_at:'2026',updated_at:'2026'});
  const names=['documentation_artifacts','documentation_artifact_revisions','documentation_claim_revision_artifacts','documentation_upload_operations'];
  if(schema===48){
   const original={...base,kind:'preserved-drive',file_id:'native-file',file_sha256:null,file_size:null,file_mime:'application/vnd.google-apps.document',validation_outcome:'native',file_source_id:'source-original',file_source_version:'7',file_copied_at:'2026',file_version:'1'};
   await insert('documentation_artifacts',{...original,id:'native',author_user_id:'staff',updated_at:'2026'});await insert('documentation_artifact_revisions',{...original,artifact_id:'native',revision:0,actor_user_id:'staff'});
   await source.prepare("INSERT INTO documentation_claim_revision_artifacts VALUES('primary','claim',0,'native',0)").run();
   await insert('documentation_drive_copy_operations',{installation_id:'primary',id:'copy',author_user_id:'staff',request_hash:'b'.repeat(64),key_hash:'f'.repeat(64),title:'Synthetic copy',caption:'',source_id:'source-original',source_version:'7',source_json:'{"native":true}',resource_ciphertext:'synthetic-resource-envelope',resource_iv:'synthetic-iv',activities_json:'[]',initiatives_json:'[]',section_revision:0,root_id:base.file_root_id,root_revision:1,connection_generation:base.file_generation,connection_iv:'synthetic-iv',state:'saved',dispatched:1,file_id:'native-file',file_version:'1',copied_at:'2026',validation_outcome:'native',artifact_id:'native',created_at:'2026',updated_at:'2026'});names.push('documentation_drive_copy_operations');
  }
  const before={};for(const name of names)before[name]=(await source.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
  const snapshotId=crypto.randomUUID(),authority={...pins,operationId:snapshotId,jobId:crypto.randomUUID(),epoch:1,state:'closed',schema,ledger:catalog.ledger};
  const capture=createSnapshotCapture({pins,database:source,store,catalogKey:key,withClosedEpoch:async(_,run)=>run(authority)});let result;
  for(let n=0;n<400;n++){result=await capture.advance(snapshotId);if(result.outcome==='snapshot-candidate')break;assert.equal(result.outcome,'pending');}assert.equal(result.outcome,'snapshot-candidate');assert.equal(result.candidate.verified,false);
  const capability={},operationId=crypto.randomUUID(),replay=createSnapshotReplay({pins:{...pins,validationDatabaseId:crypto.randomUUID()},database:target,store,capture,capability,catalogKey:key});
  for(let n=0;n<400;n++){result=await replay.advance(capability,{operationId,snapshotId});if(result.outcome==='validated')break;assert.equal(result.outcome,'pending',JSON.stringify(result));}assert.equal(result.outcome,'validated');assert.equal(result.receipt.schema,schema);assert.equal(result.receipt.verified,undefined);
  for(const name of names)assert.deepEqual((await target.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results,before[name],name);assert.deepEqual((await target.prepare('PRAGMA foreign_key_check').all()).results,[]);
  if(schema===47){
   const wrongTarget=await mf.getD1Database('WRONG'),wrong=createSnapshotReplay({pins:{...pins,validationDatabaseId:crypto.randomUUID()},database:wrongTarget,store,capture,capability,catalogKey:'schema-48-v1'});
   assert.equal((await wrong.advance(capability,{operationId:crypto.randomUUID(),snapshotId})).reason,'validation-manifest');
   await source.prepare('CREATE TABLE unexpected(value TEXT)').run();const newId=crypto.randomUUID(),unexpected=createSnapshotCapture({pins,database:source,store,catalogKey:key,withClosedEpoch:async(_,run)=>run({...authority,operationId:newId})});assert.equal((await unexpected.advance(newId)).outcome,'unknown');
  }
 });
 assert.equal(selectSnapshotCatalog().catalog.schema,49);assert.throws(()=>selectSnapshotCatalog('schema-45-v1'),/catalog-key/);
});
