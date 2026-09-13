import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { buildModel, modelSQL, validateExport, operationalProbes, cleanupSQL, capture, canonical, sha, damageSQL, schemaSQL } from '../scripts/application-recovery-model.mjs';
import { preparePublicationRestore } from '../apps/api/src/hours-publication.ts';
import { runStage, provider, parseArgs, snapshot } from '../scripts/application-recovery-spike.mjs';
import { REPOSITORY, DATABASE, SQL } from '../scripts/development-recovery-spike.mjs';
const options={repository:REPOSITORY,account:'a'.repeat(32),database:'00000000-0000-4000-8000-000000000113'};
const identity={accountId:options.account,databaseId:options.database,name:DATABASE};
const env={CLOUDFLARE_ACCOUNT_ID:options.account,CLOUDFLARE_API_TOKEN:'synthetic-not-a-credential'};
function fixtures(db){db.exec(SQL.schema.join(';'));db.exec("INSERT INTO recovery_fixture VALUES('synthetic-1','baseline'),('synthetic-2','resumed');UPDATE recovery_job SET checkpoint=2,status='migration-failed-recoverable';");}
function harness(model){const db=new DatabaseSync(':memory:');fixtures(db);const json=new Map(),files=new Map(),calls=[];let lose=false;return {db,json,files,calls,lose:()=>lose=true,api:{async identity(){return {name:DATABASE,uuid:options.database,account_id:options.account};},async query(sql){return JSON.parse(JSON.stringify(db.prepare(sql).all()));},async probe(p){assert.throws(()=>db.exec(p.sql),new RegExp(p.error));}},store:{async read(n){return json.get(n);},async save(n,v,exclusive){if(exclusive&&json.has(n))throw Error('exists');json.set(n,structuredClone(v));},async bytes(n,b){if(files.has(n))throw Error('exists');files.set(n,Buffer.from(b));},async load(n){return files.get(n);}},async transport(mode,current,validatedBytes,saveImport){calls.push(mode);if(mode==='export')files.set('export.sql',modelSQL(model.snapshot,model.tableOrder));else{db.exec('BEGIN');try{db.exec(validatedBytes.toString());db.exec('COMMIT');await saveImport({substage:'complete',bookmark:null});}catch(e){db.exec('ROLLBACK');throw e;}}if(lose){lose=false;throw Error('Synthetic response loss');}}};}
test('full 49-migration synthetic graph, canonical roundtrip and operational triggers',async()=>{
 const model=await buildModel();const other=await buildModel();try{assert.equal(model.digest,other.digest);assert.equal(model.tables.length,97);assert.equal(model.snapshot.schema.filter(r=>r.type==='trigger').length,21);const rows=model.snapshot.rows;assert.equal(rows.discord_documentation_file_drafts[0].confirmation_id,'synthetic-file-confirmation');assert.equal(rows.documentation_drive_copy_operations[0].file_id,'synthetic-copy-file');assert.equal(rows.documentation_drive_copy_operations[0].state,'reconciling');assert.equal(rows.hours_entries.find(r=>r.status==='counted').duration_minutes,45);assert.equal(rows.hours_entries.find(r=>r.status==='void').revision,2);assert.equal(rows.hours_entry_revisions.length,5);assert.equal(rows.hours_correction_resolutions.length,2);assert.equal(rows.attendance_events.length,1);assert.equal(rows.users[0].password_hash,null);assert.equal(rows.users[0].email,null);assert.equal(model.migrations.length,49);assert.ok(model.migrations.every(m=>/^[a-f0-9]{64}$/.test(m.sha256)));for(const name of ['public_hour_admission_clock','public_hour_admission','google_drive_feasibility','google_picker_intents','google_drive_proof_runs','discord_hour_drafts','discord_documentation_drafts','discord_attachment_proofs','documentation_sections','documentation_note_submission_keys','public_documentation_admission_clock','public_documentation_admission','documentation_initiatives','documentation_initiative_activities','documentation_initiative_revisions','documentation_initiative_revision_activities','documentation_metrics','documentation_metric_revisions','documentation_metric_activities','documentation_metric_revision_activities','documentation_metric_initiatives','documentation_metric_revision_initiatives','documentation_definitions','documentation_definition_revisions','documentation_claims','documentation_claim_reviews','google_drive_storage','documentation_artifacts','documentation_artifact_activities','documentation_artifact_initiatives','documentation_artifact_reviews'])assert.equal(rows[name].length,1,name);for(const name of ['documentation_notes','documentation_note_revisions','documentation_artifact_revisions','documentation_artifact_revision_activities','documentation_artifact_revision_initiatives','documentation_claim_revisions','documentation_claim_revision_activities','documentation_claim_revision_teams','documentation_claim_revision_initiatives','documentation_claim_revision_artifacts','documentation_claim_revision_metrics'])assert.equal(rows[name].length,2);assert.equal(rows.hours_publication_restore_guard.length,0);assert.equal(rows.hours_publication_generations.length,2);assert.equal(rows.hours_publication_operations.find(o=>o.provider==='discord').phase,'create_dispatched');
  const bytes=modelSQL(model.snapshot,model.tableOrder);assert.ok(validateExport(bytes,model).bytes>40000);const h=harness(model);let result=await runStage({...options,mode:'prepare'},{...h,identity,env,model});const approval=result.manifestDigest;for(const mode of ['initialize','export','damage','restore','verify']){result=await runStage({...options,mode,approval},{...h,identity,env,model});}assert.equal(result.phase,'complete');assert.deepEqual(h.json.get('state.json').probes,operationalProbes(model).map(p=>p.name));assert.equal(h.db.prepare('SELECT count(*) AS n FROM recovery_fixture').get().n,2);assert.ok(h.files.get('restore.sql').subarray(-bytes.length).equals(bytes));const count=h.calls.length;await runStage({...options,mode:'verify',approval},{...h,identity,env,model});assert.equal(h.calls.length,count);h.db.close();
 }finally{model.db.close();other.db.close();}
});
test('untrusted SQL cannot attach, invoke functions, change fixtures, remove triggers or alter data',async()=>{const m=await buildModel();try{const bytes=modelSQL(m.snapshot,m.tableOrder);for(const extra of ["ATTACH DATABASE 'external.db' AS external;","SELECT load_extension('external');","CREATE TABLE recovery_fixture(id);","UPDATE users SET active=0;","CREATE VIEW injected AS SELECT * FROM users;","PRAGMA writable_schema=ON;","SELECT randomblob(999999999);"]){assert.throws(()=>validateExport(Buffer.concat([bytes,Buffer.from('\n'+extra)]),m));}assert.throws(()=>validateExport(Buffer.from(bytes.toString().replace('Synthetic counted','Altered counted')),m));assert.ok(validateExport(Buffer.from(bytes.toString().replace(/CREATE TRIGGER hours_receipt_immutable[\s\S]*?END;/,'')),m).reconstructedObjects.includes('hours_receipt_immutable'));assert.throws(()=>validateExport(Buffer.alloc(1024*1024+1),m));}finally{m.db.close();}});
test('wrong destination, manifest approval, schema drift and tampered exports block before mutation',async()=>{const m=await buildModel();try{const h=harness(m);await assert.rejects(runStage({...options,mode:'prepare'},{...h,identity:{...identity,name:'application'},env,model:m}));const prepared=await runStage({...options,mode:'prepare'},{...h,identity,env,model:m});await assert.rejects(runStage({...options,mode:'initialize',approval:'bad'},{...h,identity,env,model:m}));assert.equal(h.calls.length,0);const approval=prepared.manifestDigest;await runStage({...options,mode:'initialize',approval},{...h,identity,env,model:m});await runStage({...options,mode:'export',approval},{...h,identity,env,model:m});h.files.set('export.sql',Buffer.from('altered'));await assert.rejects(runStage({...options,mode:'damage',approval},{...h,identity,env,model:m}));assert.equal(h.db.prepare('SELECT organization_name FROM organization_settings').get().organization_name,'Synthetic application recovery');h.db.exec('CREATE TABLE unexpected(id)');await assert.rejects(runStage({...options,mode:'status'},{...h,identity,env,model:m}));h.db.close();assert.throws(()=>parseArgs(['initialize','--repository',REPOSITORY,'--expected-account',options.account,'--expected-database',options.database,'--sql','DROP TABLE users']));}finally{m.db.close();}});
test('ambiguous import reconciles read-only without repeating mutation',async()=>{const m=await buildModel();try{const h=harness(m);const prepared=await runStage({...options,mode:'prepare'},{...h,identity,env,model:m});const approval=prepared.manifestDigest;h.lose();await assert.rejects(runStage({...options,mode:'initialize',approval},{...h,identity,env,model:m}));assert.equal(h.json.get('state.json').phase,'initialize-pending');const result=await runStage({...options,mode:'initialize',approval},{...h,identity,env,model:m});assert.equal(result.reconciled,true);assert.deepEqual(h.calls,['initialize']);h.db.close();}finally{m.db.close();}});
test('official API protocol filters tables, keeps signed URLs out of state and never forwards authorization to R2',async()=>{const calls=[];let polls=0;const fetcher=async(url,init={})=>{const u=new URL(url);calls.push({url:u,init});if(u.hostname.endsWith('.r2.cloudflarestorage.com'))return init.method==='PUT'?new Response('',{headers:{etag:'"900150983cd24fb0d6963f7d28e17f72"'}}):new Response('synthetic SQL');const body=init.body?JSON.parse(init.body):{};let result;if(u.pathname.endsWith('/export'))result=++polls===1?{status:'active',at_bookmark:'synthetic-bookmark'}:{status:'complete',result:{signed_url:'https://synthetic.r2.cloudflarestorage.com/export?signature=synthetic'}};else if(body.action==='init')result={upload_url:'https://synthetic.r2.cloudflarestorage.com/import?signature=synthetic',filename:'synthetic-file'};else result={success:true,status:'complete'};return Response.json({success:true,result});};const api=provider(options,env,fetcher,async()=>{});await api.export(['users','hours_entries']);await api.import(Buffer.from('abc'),async()=>{});assert.deepEqual(JSON.parse(calls[0].init.body).dump_options.tables,['users','hours_entries']);for(const call of calls.filter(c=>c.url.hostname.endsWith('.r2.cloudflarestorage.com'))){assert.equal(call.init.headers?.authorization,undefined);assert.equal(call.init.redirect,'error');}assert.equal(calls.filter(c=>c.init.body&&typeof c.init.body==='string'&&JSON.parse(c.init.body).action==='init').length,1);});
test('pinned Miniflare snapshot canonical replay restores all operational triggers',{timeout:120000},async(t)=>{
 const model=await buildModel();const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic")}}',compatibilityDate:'2026-08-01',d1Databases:['DB','RAW']}));
 try{const db=await mf.getD1Database('DB');await db.batch([...SQL.schema,"INSERT INTO recovery_fixture VALUES('synthetic-1','baseline'),('synthetic-2','resumed')","UPDATE recovery_job SET checkpoint=2,status='migration-failed-recoverable'"].map(sql=>db.prepare(sql)));for(const sql of unstable_splitSqlQuery(modelSQL(model.snapshot,model.tableOrder).toString()))await db.prepare(sql).run();const result=await db.prepare('PRAGMA miniflare_d1_export(?,?,?);').bind(false,false,...model.tableOrder).raw();const bytes=Buffer.from(result[0].join('\n'));const proof=validateExport(bytes,model);assert.ok(proof.reconstructedObjects.length>0);t.diagnostic('One local export: '+bytes.length+' bytes; '+proof.reconstructedObjects.length+' pinned index/trigger definitions reconstructed.');const raw=await mf.getD1Database('RAW');await assert.rejects(raw.batch(unstable_splitSqlQuery(bytes.toString()).map(sql=>raw.prepare(sql))),/no such table|foreign key/);await db.prepare(damageSQL).run();for(const sql of unstable_splitSqlQuery(cleanupSQL(model)+modelSQL(proof.snapshot,model.tableOrder).toString()))await db.prepare(sql).run();for(const p of operationalProbes(model))await assert.rejects(db.prepare(p.sql).run(),new RegExp(p.error));assert.equal((await db.prepare('SELECT organization_name FROM organization_settings').first()).organization_name,'Synthetic application recovery');assert.equal((await snapshot({query:async sql=>(await db.prepare(sql).all()).results},model)).digest,model.digest);assert.equal((await db.prepare('SELECT count(*) AS n FROM recovery_fixture').first()).n,2);assert.equal((await db.prepare('SELECT checkpoint FROM recovery_job').first()).checkpoint,2);await publicationReplayChecks(model,sql=>db.prepare(sql).run(),async sql=>(await db.prepare(sql).all()).results,sqls=>db.batch(sqls.map(sql=>db.prepare(sql))));assert.equal((await snapshot({query:async sql=>(await db.prepare(sql).all()).results},model)).digest,model.digest);
 }finally{await mf.dispose();model.db.close();}
});
test('pinned table export is not directly replayable and canonical reconstruction preserves one snapshot',async()=>{const model=await buildModel();try{const rowsFirst=Buffer.from(['PRAGMA defer_foreign_keys=TRUE;',...model.snapshot.schema.filter(r=>r.type==='table').flatMap(r=>[r.sql+';',...modelSQL({schema:[],rows:{[r.name]:model.snapshot.rows[r.name]}},[r.name]).toString().split('\n').slice(1)])].join('\n'));const raw=new DatabaseSync(':memory:');try{assert.throws(()=>raw.exec('BEGIN;'+rowsFirst.toString()+'COMMIT;'),/no such table|foreign key/);}finally{raw.close();}const proof=validateExport(rowsFirst,model);assert.ok(proof.reconstructedObjects.includes('hours_overlap_update'));assert.ok(proof.reconstructedObjects.includes('members_installation_identity'));assert.equal(sha(canonical(proof.snapshot)),model.digest);}finally{model.db.close();}});
test('provider URLs, ETags, errors and polling are bounded and fail closed',async()=>{
 for(const signed_url of ['http://synthetic.r2.cloudflarestorage.com/export','https://example.test/export','https://synthetic.r2.cloudflarestorage.com:8443/export','https://user@synthetic.r2.cloudflarestorage.com/export']){let count=0;const api=provider(options,env,async()=>{count++;return Response.json({success:true,result:{status:'complete',result:{signed_url}}});},async()=>{});await assert.rejects(api.export(['users']));assert.equal(count,1);}
 let count=0;const polling=provider(options,env,async()=>{count++;return Response.json({success:true,result:{status:'active',at_bookmark:'synthetic-bookmark'}});},async()=>{});await assert.rejects(polling.export(['users']));assert.equal(count,30);
 let imports=0;const wrong=provider(options,env,async(url,init)=>{if(new URL(url).hostname.endsWith('.r2.cloudflarestorage.com'))return new Response('',{headers:{etag:'wrong'}});imports++;return Response.json({success:true,result:{upload_url:'https://synthetic.r2.cloudflarestorage.com/object',filename:'synthetic'}});});await assert.rejects(wrong.import(Buffer.from('abc'),async()=>{}));assert.equal(imports,1);
 const unavailable=provider(options,env,async()=>{throw Error('synthetic provider body that must not escape');});await assert.rejects(unavailable.query('SELECT 1'),e=>!e.message.includes('provider body'));
});
test('failed destructive import stays pending and cannot restart against a damaged database',async()=>{const m=await buildModel();try{const h=harness(m);const prepared=await runStage({...options,mode:'prepare'},{...h,identity,env,model:m});const approval=prepared.manifestDigest;for(const mode of ['initialize','export','damage'])await runStage({...options,mode,approval},{...h,identity,env,model:m});let attempts=0;const broken={...h,transport:async()=>{attempts++;throw Error('Synthetic import failure');},identity,env,model:m};await assert.rejects(runStage({...options,mode:'restore',approval},broken));await assert.rejects(runStage({...options,mode:'restore',approval},broken));assert.equal(attempts,1);assert.equal(h.json.get('state.json').phase,'restore-pending');assert.equal(h.db.prepare('SELECT count(*) AS n FROM recovery_fixture').get().n,2);h.db.close();}finally{m.db.close();}});

test('import persists each dispatch boundary, uses exact poll union and keeps provider details out of checkpoints',async()=>{
 const saved=[],calls=[];let last;
 const api=provider(options,env,async(url,init={})=>{
  if(init.method==='PUT'){assert.equal(last.substage,'upload-dispatched');return new Response('',{headers:{etag:'"900150983cd24fb0d6963f7d28e17f72"'}});}
  const body=JSON.parse(init.body);calls.push(body);assert.equal(last.substage,body.action+'-dispatched');
  if(body.action==='init')return Response.json({success:true,result:{upload_url:'https://synthetic.r2.cloudflarestorage.com/object?signed=do-not-save',filename:'do-not-save-provider-filename'}});
  if(body.action==='ingest')return Response.json({success:true,result:{success:true,status:'active',at_bookmark:'synthetic-operation'}});
  assert.deepEqual(body,{action:'poll',current_bookmark:'synthetic-operation'});return Response.json({success:true,result:{success:true,status:'complete'}});
 },async()=>{});
 await api.import(Buffer.from('abc'),async value=>{last=structuredClone(value);saved.push(last);});
 assert.deepEqual(saved.map(s=>s.substage),['init-dispatched','upload-ready','upload-dispatched','upload-complete','ingest-dispatched','poll-ready','poll-dispatched','complete']);
 assert.equal(calls.filter(c=>c.action==='init').length,1);assert.doesNotMatch(JSON.stringify(saved),/do-not-save|https|filename|upload_url/);
 let dispatched=0;await assert.rejects(provider(options,env,async()=>{dispatched++;}).import(Buffer.from('abc'),async()=>{throw Error('Synthetic checkpoint failure');}));assert.equal(dispatched,0);
});

test('recorded interrupted import resumes only its bookmark and verifies the exact graph',async()=>{
 const m=await buildModel();try{
  const h=harness(m),calls=[];let interrupted=true;
  const live=provider(options,env,async(url,init={})=>{
   if(init.method==='PUT')return new Response('',{headers:{etag:'"'+(await import('node:crypto')).createHash('md5').update(h.files.get('initialize.sql')).digest('hex')+'"'}});
   const body=JSON.parse(init.body);calls.push(body);
   if(body.action==='init')return Response.json({success:true,result:{upload_url:'https://synthetic.r2.cloudflarestorage.com/object',filename:'synthetic'}});
   if(body.action==='ingest')return Response.json({success:true,result:{success:true,status:'active',at_bookmark:'synthetic-recorded'}});
   assert.deepEqual(body,{action:'poll',current_bookmark:'synthetic-recorded'});
   if(interrupted)throw Error('Synthetic response interruption');
   h.db.exec('BEGIN;'+h.files.get('initialize.sql').toString()+'COMMIT;');return Response.json({success:true,result:{success:true,status:'complete'}});
  },async()=>{});
  const context={...h,api:{...h.api,resumeImport:live.resumeImport},transport:async(mode,model,bytes,save)=>live.import(bytes,save),identity,env,model:m};
  const prepared=await runStage({...options,mode:'prepare'},context),approval=prepared.manifestDigest;
  await assert.rejects(runStage({...options,mode:'initialize',approval},context));
  assert.equal(h.json.get('state.json').transport.substage,'poll-dispatched');assert.equal(h.json.get('state.json').transport.bookmark,'synthetic-recorded');
  const status=await runStage({...options,mode:'status'},context);assert.equal(status.baseline,false);assert.deepEqual(status.transport,{substage:'poll-dispatched',hasBookmark:true});
  interrupted=false;const result=await runStage({...options,mode:'initialize',approval},context);assert.equal(result.reconciled,true);assert.equal(result.phase,'initialized');
  assert.equal(calls.filter(c=>c.action==='init').length,1);assert.equal(calls.filter(c=>c.action==='ingest').length,1);assert.equal(calls.filter(c=>c.action==='poll').length,2);h.db.close();
 }finally{m.db.close();}
});

test('legacy pending, ambiguous init/ingest and missing-bookmark records cannot reissue or infer completion from rows',async()=>{
 const m=await buildModel();try{
  for(const substage of [undefined,'init-dispatched','upload-dispatched','upload-complete','ingest-dispatched','poll-dispatched']){
   const h=harness(m),prepared=await runStage({...options,mode:'prepare'},{...h,identity,env,model:m}),approval=prepared.manifestDigest;
   h.db.exec('BEGIN;'+h.files.get('initialize.sql').toString()+'COMMIT;');
   h.json.set('state.json',{phase:'initialize-pending',manifestDigest:approval,...(substage?{transport:{version:1,operation:'initialize',payloadSha256:sha(h.files.get('initialize.sql')),substage,bookmark:null}}:{})});
   let polls=0;await assert.rejects(runStage({...options,mode:'initialize',approval},{...h,api:{...h.api,resumeImport:async()=>{polls++;}},identity,env,model:m}));assert.equal(polls,0);assert.equal(h.calls.length,0);assert.equal(h.json.get('state.json').phase,'initialize-pending');h.db.close();
  }
 }finally{m.db.close();}
});

test('inner failure, malformed bookmarks and provider errors retain fixed diagnostics without provider text',async()=>{
 for(const result of [{success:false,status:'complete',error:'private-provider-message'},{status:'complete'},{success:true,status:'active',at_bookmark:'https://private.invalid'},{success:true,status:'error',error:'private-provider-message'}]){
  const saved=[];const api=provider(options,env,async()=>Response.json({success:true,result}),async()=>{});
  await assert.rejects(api.import(Buffer.from('abc'),async v=>saved.push(v)),e=>e.diagnostic&& !e.message.includes('private-provider'));
  assert.doesNotMatch(JSON.stringify(saved),/private|https/);assert.ok(saved.at(-1).diagnostic.code.startsWith('provider_'));
 }
 const saved=[];const api=provider(options,env,async()=>Response.json({success:false,errors:[{message:'private-token-and-url'}]},{status:403}));
 await assert.rejects(api.import(Buffer.from('abc'),async v=>saved.push(v)),e=>e.diagnostic.code==='provider_http'&&e.diagnostic.httpStatus===403);
 assert.deepEqual(saved.at(-1),{substage:'init-dispatched',bookmark:null,diagnostic:{code:'provider_http',httpStatus:403}});
 let calls=0;await assert.rejects(provider(options,env,async()=>{calls++;}).resumeImport({substage:'ingest-dispatched',bookmark:null},async()=>{}));assert.equal(calls,0);
});


test('documented import progress can omit status while retaining strict success and bookmark checks',async()=>{
 for(const status of [undefined,'active']){
  const saved=[],calls=[];
  const api=provider(options,env,async(url,init)=>{
   const body=JSON.parse(init.body);calls.push(body);
   return Response.json({success:true,result:body.action==='init'?{success:true,...(status===undefined?{}:{status}),at_bookmark:'synthetic-progress'}:{success:true,status:'complete'}});
  },async()=>{});
  await api.import(Buffer.from('abc'),async value=>saved.push(value));
  assert.deepEqual(calls,[{action:'init',etag:'900150983cd24fb0d6963f7d28e17f72'},{action:'poll',current_bookmark:'synthetic-progress'}]);
  assert.equal(saved.at(-1).substage,'complete');
 }
 for(const result of [{success:true,status:'unknown',at_bookmark:'synthetic'},{success:true,status:null,at_bookmark:'synthetic'},{success:true},{success:false,at_bookmark:'synthetic'}]){
  let calls=0;await assert.rejects(provider(options,env,async()=>{calls++;return Response.json({success:true,result});}).import(Buffer.from('abc'),async()=>{}));assert.equal(calls,1);
 }
});

test('storage failures retain only fixed nested cause categories and never dispatch ingest',async()=>{
 const privateText='https://synthetic.r2.cloudflarestorage.com/object?signed=never-output';
 const cycle=new Error(privateText);cycle.cause=cycle;
 const hostile=Object.defineProperty({},'code',{get(){throw Error(privateText);}});
 const examples=[['dns',{code:'ENOTFOUND'}],['tls',{code:'ERR_TLS_CERT_ALTNAME_INVALID'}],['socket',{code:'ECONNRESET'}],['timeout',{code:'UND_ERR_CONNECT_TIMEOUT'}],['aborted',{name:'AbortError'}],...['ERR_INVALID_URL','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','UND_ERR_INVALID_ARG','UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'].map(code=>['request_construction',{code}]),['unknown',{code:privateText}],['unknown',cycle],['unknown',hostile]];
 for(const [category,inner]of examples){
  const expected={code:'storage_upload',transportCause:category,...(category==='request_construction'?{constructionCode:inner.code}:{}),...(category==='request_construction'&&inner.code==='UND_ERR_INVALID_ARG'?{constructionReason:'unknown'}:{})};const saved=[],actions=[];const failure=new TypeError(privateText,{cause:new AggregateError([inner],privateText)});
  const api=provider(options,env,async(url,init)=>{if(init.method==='PUT')throw failure;const body=JSON.parse(init.body);actions.push(body.action);return Response.json({success:true,result:{upload_url:privateText,filename:'never-output-filename'}});});
  await assert.rejects(api.import(Buffer.from('abc'),async value=>saved.push(value)),error=>{assert.deepEqual(error.diagnostic,expected);assert.equal(error.cause,undefined);assert.doesNotMatch(error.message+JSON.stringify(error),/never-output|https|ENOTFOUND|ECONNRESET/);return true;});
  assert.deepEqual(actions,['init']);assert.deepEqual(saved.at(-1),{substage:'upload-dispatched',bookmark:null,diagnostic:expected});assert.doesNotMatch(JSON.stringify(saved),/never-output|https|filename|signed=/);
 }
});

test('storage cause survives the validated stage checkpoint and cannot authorize a fresh attempt',async()=>{
 const m=await buildModel();try{
  const h=harness(m);let puts=0,inits=0;
  const live=provider(options,env,async(url,init)=>{if(init.method==='PUT'){puts++;throw new TypeError('synthetic private endpoint',{cause:Object.assign(new Error('synthetic private hostname'),{code:'UND_ERR_INVALID_ARG'})});}inits++;return Response.json({success:true,result:{upload_url:'https://synthetic.r2.cloudflarestorage.com/object',filename:'synthetic'}});});
  const context={...h,transport:async(mode,model,bytes,save)=>live.import(bytes,save),identity,env,model:m};const prepared=await runStage({...options,mode:'prepare'},context),approval=prepared.manifestDigest;
  await assert.rejects(runStage({...options,mode:'initialize',approval},context));const state=h.json.get('state.json');assert.equal(state.phase,'initialize-pending');assert.equal(state.transport.substage,'upload-dispatched');assert.deepEqual(state.transport.diagnostic,{code:'storage_upload',transportCause:'request_construction',constructionCode:'UND_ERR_INVALID_ARG',constructionReason:'unknown'});
  await assert.rejects(runStage({...options,mode:'initialize',approval},context));assert.equal(inits,1);assert.equal(puts,1);assert.equal(h.db.prepare('SELECT count(*) AS n FROM recovery_fixture').get().n,2);h.db.close();
 }finally{m.db.close();}
});

test('native Node Request accepts the exact bounded Buffer upload options without forwarding credentials',async()=>{
 let upload=0;const api=provider(options,env,async(url,init)=>{
  if(init.method==='PUT'){upload++;const request=new Request(url,init);assert.equal(request.redirect,'error');assert.equal(request.headers.get('authorization'),null);assert.equal(request.headers.get('content-length'),null);assert.deepEqual(Buffer.from(await request.arrayBuffer()),Buffer.from('abc'));return new Response('',{headers:{etag:'"900150983cd24fb0d6963f7d28e17f72"'}});}
  return Response.json({success:true,result:JSON.parse(init.body).action==='init'?{upload_url:'https://synthetic.r2.cloudflarestorage.com/object',filename:'synthetic'}:{success:true,status:'complete'}});
 });await api.import(Buffer.from('abc'),async()=>{});assert.equal(upload,1);
});

test('native Node fetch uploads exact Buffer bytes over loopback and sanitizes a real invalid-header error',{timeout:15000},async()=>{
 const model=await buildModel(),bytes=modelSQL(model.snapshot,model.tableOrder);assert.ok(bytes.length>40_000);const etag=createHash('md5').update(bytes).digest('hex');let uploads=0;
 const server=createServer((request,response)=>{uploads++;const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{assert.equal(request.method,'PUT');assert.equal(request.headers.authorization,undefined);assert.equal(request.headers.cookie,undefined);assert.equal(request.headers['transfer-encoding'],undefined);assert.equal(request.headers['content-length'],String(bytes.length));assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(sha(Buffer.concat(chunks)),sha(bytes));response.writeHead(200,{etag:'"'+etag+'"'});response.end();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const local='http://127.0.0.1:'+server.address().port+'/synthetic';
 try{
  for(const variant of ['url','string','invalid']){
   const invalid=variant==='invalid';
   const saved=[],actions=[];const api=provider(options,env,async(url,init)=>{
    if(init.method==='PUT'){assert.equal(new Headers(init.headers).has('content-length'),false);const destination=new URL(local+'?X-Amz-Signature=synthetic');return fetch(variant==='url'?destination:destination.href,{...init,...(invalid?{headers:{...init.headers,'content-length':'synthetic-invalid'}}:{})});}
    const body=JSON.parse(init.body);actions.push(body.action);return Response.json({success:true,result:body.action==='init'?{upload_url:'https://synthetic.r2.cloudflarestorage.com/object?signature=never-output',filename:'synthetic'}:{success:true,status:'complete'}});
   });
   if(invalid){await assert.rejects(api.import(bytes,async value=>saved.push(value)),error=>{assert.deepEqual(error.diagnostic,{code:'storage_upload',transportCause:'request_construction',constructionCode:'UND_ERR_INVALID_ARG',constructionReason:'invalid_content_length'});assert.equal(error.cause,undefined);return true;});assert.deepEqual(actions,['init']);assert.equal(saved.at(-1).diagnostic.constructionCode,'UND_ERR_INVALID_ARG');assert.doesNotMatch(JSON.stringify(saved),/never-output|127\.0\.0\.1|synthetic-invalid/);}
   else{await api.import(bytes,async value=>saved.push(value));assert.equal(saved.at(-1).substage,'complete');assert.deepEqual(actions,['init','ingest']);}
  }
  assert.equal(uploads,2);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));model.db.close();}
});

test('invalid-argument detail uses exact fixed literals only, with no message coercion or leakage',async()=>{
 const literals=[['duplicate content-length header','duplicate_content_length'],['invalid content-length header','invalid_content_length'],['invalid request path','invalid_path'],['path must be a string','invalid_path'],['path must be an absolute URL or start with a slash','invalid_path'],['body must be a string, a Buffer, a Readable stream, an iterable, or an async iterable','unsupported_body'],['Proxy URL is mandatory','proxy_configuration'],['Proxy URL must use socks5:// or socks:// protocol','proxy_configuration'],['Cannot establish tunnel connection without a proxy client','proxy_tunnel'],['invalid content-length header https://private.invalid/?secret=never-output','unknown']];
 const hostile=Object.defineProperty({code:'UND_ERR_INVALID_ARG'},'message',{get(){throw Error('never-output');}});
 const values=[...literals.map(([message,reason])=>[{code:'UND_ERR_INVALID_ARG',message},reason]),[hostile,'unknown'],[{code:'UND_ERR_INVALID_ARG',message:{toString(){throw Error('never-output');}}},'unknown']];
 for(const [cause,reason]of values){
  const saved=[],actions=[];const api=provider(options,env,async(url,init)=>{
   if(init.method==='PUT')throw new TypeError('never-output',{cause:new AggregateError([cause],'never-output')});
   actions.push(JSON.parse(init.body).action);return Response.json({success:true,result:{upload_url:'https://synthetic.r2.cloudflarestorage.com/object',filename:'synthetic'}});
  });
  await assert.rejects(api.import(Buffer.from('abc'),async value=>saved.push(value)),error=>{assert.equal(error.diagnostic.constructionReason,reason);assert.equal(error.cause,undefined);assert.doesNotMatch(error.message+JSON.stringify(error),/never-output|private.invalid|content-length header/);return true;});
  assert.deepEqual(actions,['init']);assert.equal(saved.at(-1).substage,'upload-dispatched');assert.equal(saved.at(-1).diagnostic.constructionReason,reason);assert.doesNotMatch(JSON.stringify(saved),/never-output|private.invalid/);
 }
 let reads=0;const cause=Object.defineProperty({code:'ENOTFOUND'},'message',{get(){reads++;throw Error('never-output');}});
 const api=provider(options,env,async(url,init)=>{if(init.method==='PUT')throw cause;return Response.json({success:true,result:{upload_url:'https://synthetic.r2.cloudflarestorage.com/object',filename:'synthetic'}});});
 await assert.rejects(api.import(Buffer.from('abc'),async()=>{}),error=>error.diagnostic.transportCause==='dns'&&!('constructionReason'in error.diagnostic));assert.equal(reads,0);
});

test('checkpoint rejects arbitrary or mismatched construction reasons before saving them',async()=>{
 const model=await buildModel();try{
  for(const diagnostic of [
   {code:'storage_upload',transportCause:'request_construction',constructionCode:'UND_ERR_INVALID_ARG',constructionReason:'invalid_path'},
   {code:'storage_upload',transportCause:'request_construction',constructionCode:'UND_ERR_INVALID_ARG',constructionReason:'never-output'},
   {code:'storage_upload',transportCause:'request_construction',constructionCode:'ERR_INVALID_URL',constructionReason:'invalid_path'},
  ]){
   const h=harness(model);try{
    const context={...h,identity,env,model,transport:async(mode,current,bytes,save)=>{await save({substage:'upload-dispatched',bookmark:null,diagnostic});throw Error('synthetic stop');}};
    const prepared=await runStage({...options,mode:'prepare'},context);await assert.rejects(runStage({...options,mode:'initialize',approval:prepared.manifestDigest},context));
    assert.equal(h.json.get('state.json').transport?.diagnostic?.constructionReason,diagnostic.constructionCode==='UND_ERR_INVALID_ARG'&&diagnostic.constructionReason==='invalid_path'?'invalid_path':undefined);
   }finally{h.db.close();}
  }
 }finally{model.db.close();}
});

test('inner failures retain their dispatch stage and only fixed provider shape at the first terminal checkpoint',async()=>{
 for(const stage of ['init','ingest','poll'])for(const result of [{success:false,status:'error',error:'never-output'}, {success:false}, {success:true,status:'complete',error:'never-output'}, {status:'complete'}, {success:'never-output',status:{private:'never-output'}}, {success:true,status:'error',errors:['never-output']}]){
  const saved=[],actions=[];const api=provider(options,env,async(url,init)=>{
   if(init.method==='PUT')return new Response('',{headers:{etag:'"900150983cd24fb0d6963f7d28e17f72"'}});
   const action=JSON.parse(init.body).action;actions.push(action);
   return Response.json({success:true,result:action===stage?result:action==='init'?{upload_url:'https://synthetic.r2.cloudflarestorage.com/object',filename:'synthetic'}:{success:true,status:'active',at_bookmark:'synthetic-bookmark'}});
  },async()=>{});
  await assert.rejects(api.import(Buffer.from('abc'),async value=>saved.push(value)),error=>{
   assert.deepEqual(error.diagnostic,{code:'provider_inner_failure',rejectedAt:stage+'-dispatched',successState:result.success===false?'false':result.success===true?'true':result.success===undefined?'missing':'invalid',statusState:result.status===undefined?'missing':typeof result.status==='string'?result.status:'unknown'});return true;
  });
  const terminal=saved.find(value=>value.substage==='terminal-failure');assert.equal(terminal.diagnostic.rejectedAt,stage+'-dispatched');assert.doesNotMatch(JSON.stringify(saved),/never-output|private/);assert.equal(actions.at(-1),stage);
 }
});

test('rejection checkpoint shape rejects partial, arbitrary and mismatched fields but permits old records',async()=>{
 const model=await buildModel();try{
  for(const extra of [{},{rejectedAt:'init-dispatched',successState:'false',statusState:'error'},{rejectedAt:'never-output',successState:'false',statusState:'error'},{rejectedAt:'init-dispatched'},{rejectedAt:'init-dispatched',successState:'never-output',statusState:'error'}]){
   const h=harness(model);try{
    const diagnostic={code:'provider_inner_failure',...extra};const context={...h,identity,env,model,transport:async(mode,current,bytes,save)=>{await save({substage:'terminal-failure',bookmark:null,diagnostic});throw Error('stop');}};
    const prepared=await runStage({...options,mode:'prepare'},context);await assert.rejects(runStage({...options,mode:'initialize',approval:prepared.manifestDigest},context));
    const valid=!Object.keys(extra).length||extra.rejectedAt==='init-dispatched'&&extra.successState==='false';assert.equal(Boolean(h.json.get('state.json').transport),valid);
   }finally{h.db.close();}
  }
 }finally{model.db.close();}
});

test('canonical initialization and restore survive statement transaction boundaries with foreign keys enabled',async()=>{
 const model=await buildModel(),db=new DatabaseSync(':memory:'),old=new DatabaseSync(':memory:');
 try{
  const bytes=modelSQL(model.snapshot,model.tableOrder),statements=unstable_splitSqlQuery(bytes.toString());
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  // Reproduce the old alphabetical INSERT order with otherwise identical SQL.
  const inserts=statements.filter(sql=>sql.startsWith('INSERT INTO')).sort((a,b)=>a.match(/^INSERT INTO "([^"]+)"/)[1].localeCompare(b.match(/^INSERT INTO "([^"]+)"/)[1]));
  for(const sql of statements.filter(sql=>!sql.startsWith('INSERT INTO')&&!sql.startsWith('CREATE TRIGGER')))old.exec(sql);
  assert.throws(()=>{for(const sql of inserts)old.exec(sql);},/FOREIGN KEY constraint failed/);
  const graph=async()=>snapshot({query:async sql=>JSON.parse(JSON.stringify(db.prepare(sql).all()))},model);
  fixtures(db);const fixtureBefore=canonical(db.prepare('SELECT * FROM recovery_fixture ORDER BY id').all());
  for(const sql of statements)db.exec(sql);
  assert.equal((await graph()).digest,model.digest);
  db.exec(damageSQL);assert.notEqual((await graph()).digest,model.digest);
  const restore=cleanupSQL(model)+bytes.toString();for(const sql of unstable_splitSqlQuery(restore))db.exec(sql);
  assert.equal((await graph()).digest,model.digest);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  for(const probe of operationalProbes(model))assert.throws(()=>db.exec(probe.sql),new RegExp(probe.error));
  assert.equal(canonical(db.prepare('SELECT * FROM recovery_fixture ORDER BY id').all()),fixtureBefore);
  assert.equal(db.prepare('SELECT checkpoint FROM recovery_job').get().checkpoint,2);
  assert.throws(()=>modelSQL(model.snapshot),/complete reviewed table order/);
  assert.throws(()=>modelSQL(model.snapshot,model.tableOrder.slice(1)),/complete reviewed table order/);
 }finally{db.close();old.close();model.db.close();}
});

// Each successful mutation is followed by canonical reset; each failing guard is
// one atomic batch, so even a rejected assertion cannot leak coordination rows.
async function publicationReplayChecks(model,run,all,batch){
 const reset=()=>batch(unstable_splitSqlQuery(cleanupSQL(model)+modelSQL(model.snapshot,model.tableOrder).toString()));
 const cases=[
  ["UPDATE hours_activities SET revision=revision+1 WHERE id='synthetic-event'",['google','discord']],
  ["UPDATE platform_module_configuration SET hours_enabled=0",['google','discord']],
  ["UPDATE installations SET google_calendar_enabled=0",['google']],
  ["UPDATE encrypted_integrations SET iv='synthetic-rotated' WHERE provider='discord'",['discord']],
  ["UPDATE google_connections SET active_iv='synthetic-rotated'",['google']],
 ];
 for(const [sql,providers] of cases){
  await run(sql);
  for(const row of await all('SELECT * FROM hours_publication_intents'))assert.equal(row.needs_review,Number(providers.includes(row.provider)),sql);
  for(const row of await all('SELECT * FROM hours_publication_operations')){assert.equal(row.status,providers.includes(row.provider)?'review':'processing');assert.equal(row.lease_token,'synthetic-expired-lease');}
  await reset();
 }
 await run("UPDATE hours_activities SET archived=1,revision=revision+1 WHERE id='synthetic-event'");
 assert.ok((await all('SELECT * FROM hours_publication_intents')).every(r=>r.enabled===0));
 assert.ok((await all('SELECT * FROM hours_publication_generations')).every(r=>r.abandoned===1));
 assert.equal((await all("SELECT * FROM hours_publication_operations WHERE action='delete' AND status='pending'")).length,2);
 await reset();
 // Isolate ownership rejection from the independent uncertain-create guard.
 for(const generations of [[],model.snapshot.rows.hours_publication_generations.map(r=>({...r,provider_event_id:null}))]){
  const json=JSON.stringify(generations).replaceAll("'","''");
  await assert.rejects(batch(["UPDATE hours_publication_operations SET phase='known',lease_token=NULL,lease_expires_ms=NULL",`INSERT INTO hours_publication_restore_guard VALUES('primary','${json}')`,"DELETE FROM installations WHERE id='primary'"]),/hours_publication_restore_identity/);
  assert.equal((await all('SELECT * FROM hours_publication_restore_guard')).length,0);
  assert.equal((await all("SELECT * FROM hours_publication_operations WHERE phase='create_dispatched'")).length,1);
 }
 // Isolate matching publication ownership from the separately tested copy guard.
 // The synthetic copy deletion below is rolled back by the final failure.
 // Matching ownership passes its guard. Force a final CHECK failure to roll back
 // the destructive probe without replacing the fixture's installation.
 const identity=JSON.stringify(model.snapshot.rows.hours_publication_generations).replaceAll("'","''");
 await assert.rejects(batch(["DELETE FROM documentation_drive_copy_operations", "UPDATE hours_publication_operations SET phase='known',lease_token=NULL,lease_expires_ms=NULL",`INSERT INTO hours_publication_restore_guard VALUES('primary','${identity}')`,"DELETE FROM installations WHERE id='primary'","INSERT INTO public_hour_admission_clock VALUES('missing',-1)"]),/CHECK constraint failed/);
 assert.equal((await all('SELECT * FROM hours_publication_restore_guard')).length,0);
}

test('schema 38 replay retains raw leases while logical restore normalizes publication authority',async()=>{
 const model=await buildModel();const db=new DatabaseSync(':memory:');try{
  for(const sql of unstable_splitSqlQuery(modelSQL(model.snapshot,model.tableOrder).toString()))db.exec(sql);
  const rows=JSON.parse(canonical(capture(db).rows));preparePublicationRestore(rows);
  assert.ok(rows.hours_publication_intents.every(r=>r.needs_review===1&&r.revision===3));
  assert.ok(rows.hours_publication_operations.every(r=>r.lease_token===null&&r.lease_expires_ms===null&&r.status==='review'));
  assert.equal(sha(canonical(capture(db))),model.digest);
  const batch=async sqls=>{db.exec('BEGIN');try{for(const sql of sqls)db.exec(sql);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}};
  await publicationReplayChecks(model,async sql=>db.exec(sql),async sql=>db.prepare(sql).all(),batch);
  assert.equal(sha(canonical(capture(db))),model.digest);
 }finally{db.close();model.db.close();}
});
