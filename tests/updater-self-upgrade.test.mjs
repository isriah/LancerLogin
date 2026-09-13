import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {sha256} from '../packages/shared/src/updater/application-release.mjs';
import {updaterSignedBytes} from '../packages/shared/src/updater/updater-release.mjs';
import {createCheckpointCipher} from '../apps/updater/src/checkpoint.mjs';
import {createArtifactStore,ARTIFACT_CHUNK_BYTES} from '../apps/updater/src/artifact-store.mjs';
import {createUpdaterCodeTransport} from '../apps/updater/src/updater-code.mjs';
import {createSelfUpgradeExecutor} from '../apps/updater/src/self-upgrade.mjs';
import {createUpdaterSelfRecovery} from '../apps/updater/self-recovery.mjs';
const encode=s=>new TextEncoder().encode(s),response=result=>Response.json({success:true,result});
async function fixture({large=false}={}){
 const sql=new DatabaseSync(':memory:');for(const name of ['0001_updater_state.sql','0002_updater_artifacts.sql','0005_updater_maintenance.sql','0007_updater_job_maintenance.sql'])sql.exec(readFileSync(new URL('../apps/updater/state/'+name,import.meta.url),'utf8'));
 sql.prepare('INSERT INTO updater_state VALUES(1,?,0,?)').run('fixture',JSON.stringify({format:1,installed:{updaterVersion:'1.0.0'},job:null}));sql.exec("INSERT INTO updater_maintenance VALUES(1,'fixture',0,'open',NULL)");
 let queries=0,primaryReads=0;const database={withSession(mode){assert.equal(mode,'first-primary');primaryReads++;return this;},prepare(text){let args=[];return {bind(...values){args=values;return this;},async first(){queries++;return sql.prepare(text).get(...args)??null;},async all(){queries++;return {results:sql.prepare(text).all(...args)};}};}};
 const cipher=await createCheckpointCipher(crypto.getRandomValues(new Uint8Array(32)),'fixture'),store=createArtifactStore({database,installationId:'fixture',cipher});
 const signer=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),trust={product:'LancerLogin',channel:'development',keyId:'synthetic',repository:{id:1,owner:'synthetic',name:'updater'},publicKey:new Uint8Array(await crypto.subtle.exportKey('raw',signer.publicKey))};
 const pins={installationId:'fixture',accountId:'a'.repeat(32),worker:'synthetic-updater',updaterDatabaseId:'11111111-1111-4111-8111-111111111111',workerSettings:{compatibility_date:'2026-09-04',compatibility_flags:[]},nonsecretBindings:[{name:'UPDATER_DB',type:'d1',id:'11111111-1111-4111-8111-111111111111'},{name:'PIN',type:'plain_text',text:'synthetic-fixed-trust'}],secretBindings:[{name:'PRIVATE_KEY',type:'secret_text'}]};
 const releases=[];for(const sequence of [1,2,3]){const bytes=large&&sequence===2?new Uint8Array(16777216).fill(32):encode(`export default {fetch(){${sequence===2?'throw Error("synthetic broken updater")':'return new Response("synthetic")'}}}`);const manifest={format:1,kind:'updater',product:trust.product,channel:trust.channel,keyId:trust.keyId,repository:trust.repository,sequence,version:sequence+'.0.0',sourceCommit:String(sequence).repeat(40),compatibility:{updaterVersion:{min:'1.0.0',max:'9.0.0'},stateSchema:{min:7,max:7}},targetStateSchema:7,artifact:{role:'updater',name:'updater.mjs',bytes:bytes.length,sha256:await sha256(bytes)}};const manifestBytes=encode(JSON.stringify(manifest)),signatureBytes=new Uint8Array(await crypto.subtle.sign('Ed25519',signer.privateKey,updaterSignedBytes(manifestBytes)));releases.push({manifestBytes,signatureBytes,bytes,manifest});}
 let deployed=releases[0].bytes,active={id:crypto.randomUUID(),annotations:{}},deploymentId=crypto.randomUUID(),settings={...pins.workerSettings,bindings:[...pins.nonsecretBindings,...pins.secretBindings]},puts=0,fenced=true,lose=false,matches=1;const versions=[active];
 const fetcher=async(url,init)=>{const u=new URL(url);assert.equal(u.origin,'https://api.cloudflare.com');assert.ok(u.pathname.startsWith('/client/v4/accounts/'+pins.accountId+'/workers/scripts/'+pins.worker));const suffix=u.pathname.split('/scripts/'+pins.worker)[1];
  if(init.method==='PUT'){assert.equal(fenced,true);puts++;const metadata=JSON.parse(init.body.get('metadata'));assert.deepEqual(metadata.keep_bindings,['secret_text','secret_key']);assert.deepEqual(metadata.bindings,pins.nonsecretBindings);assert.equal(metadata.main_module,'updater.mjs');deployed=new Uint8Array(await init.body.get('updater.mjs').arrayBuffer());active={id:crypto.randomUUID(),annotations:metadata.annotations};versions.push(active);deploymentId=crypto.randomUUID();if(lose)throw Error('synthetic lost response');return response({id:active.id});}
  if(suffix==='/settings')return response(settings);
  if(suffix==='/deployments')return response({deployments:[{id:deploymentId,versions:[{version_id:active.id,percentage:100}]}]});
  if(suffix==='/versions')return response({items:matches===0?[]:matches===2?[...versions,active]:versions});
  if(suffix.startsWith('/versions/'))return response(versions.find(v=>v.id===suffix.split('/').at(-1)));
  if(suffix==='/content/v2')return new Response(deployed);
  throw Error('unexpected synthetic path');
 };
 const capability={},transport=createUpdaterCodeTransport({pins,trust,token:'synthetic-provider-token',fetch:fetcher});
 const dependencies={installationId:'fixture',database,store,transport,trust,capability,withUpdaterQuiescence:fn=>fn({async assertHeld(){assert.equal(fenced,true,'external-fence-not-held');}})};
 const executor=await createSelfUpgradeExecutor(dependencies);
 const input=(n,requestId)=>({requestId,manifestBytes:releases[n].manifestBytes,signatureBytes:releases[n].signatureBytes});
 const stage=async(n,requestId)=>{let max=0;for(let index=0;index<Math.ceil(releases[n].bytes.length/ARTIFACT_CHUNK_BYTES);index++){const before=queries;await executor.writeChunk(capability,{requestId,index,bytes:releases[n].bytes.slice(index*ARTIFACT_CHUNK_BYTES,(index+1)*ARTIFACT_CHUNK_BYTES)});max=Math.max(max,queries-before);}return max;};
 await executor.initialize(capability,{...input(0,'bootstrap'),installed:{updaterVersion:'1.0.0',stateSchema:7,highestUpdaterSequence:1}});await stage(0,'bootstrap');await executor.advance(capability,{requestId:'bootstrap'});
 return {async resign(manifest){const manifestBytes=encode(JSON.stringify(manifest));return {manifestBytes,signatureBytes:new Uint8Array(await crypto.subtle.sign('Ed25519',signer.privateKey,updaterSignedBytes(manifestBytes)))};},sql,store,executor,capability,dependencies,input,stage,releases,pins,transport,get puts(){return puts;},get queries(){return queries;},get primaryReads(){return primaryReads;},fence(v){fenced=v;},lose(v){lose=v;},matches(v){matches=v;},drift(v){settings={...pins.workerSettings,bindings:v?[...pins.nonsecretBindings,...pins.secretBindings,{name:'OTHER',type:'secret_text'}]:[...pins.nonsecretBindings,...pins.secretBindings]};}};
}
test('independent executor recovers broken replacement and lost acknowledgments with monotonic updater sequence',async()=>{
 const f=await fixture();try{
  await f.executor.admit(f.capability,f.input(1,'upgrade'));await f.stage(1,'upgrade');await f.executor.advance(f.capability,{requestId:'upgrade'});f.lose(true);
  await f.executor.advance(f.capability,{requestId:'upgrade'});assert.equal(f.puts,1);assert.equal((await f.executor.status(f.capability)).installed.highestUpdaterSequence,2);
  const recovery=await createUpdaterSelfRecovery(f.dependencies);for(const count of [0,2]){f.matches(count);assert.equal((await recovery.advance(f.capability,{requestId:'upgrade'})).job.phase,'dispatched');assert.equal(f.puts,1);await assert.rejects(recovery.recover(f.capability,{requestId:'upgrade',recoveryRequestId:'restore'}),/self-recovery-unresolved/);}f.matches(1);
  assert.equal((await recovery.advance(f.capability,{requestId:'upgrade'})).job.phase,'deployed');
  await recovery.recover(f.capability,{requestId:'upgrade',recoveryRequestId:'restore'});await recovery.advance(f.capability,{requestId:'restore'});assert.equal(f.puts,2);
  const done=await recovery.advance(f.capability,{requestId:'restore'});assert.equal(done.job.phase,'recovered');assert.deepEqual(done.installed,{updaterVersion:'1.0.0',stateSchema:7,highestUpdaterSequence:2});
  await assert.rejects(f.executor.admit(f.capability,f.input(1,'replay')),/updater-downgrade/);assert.ok(f.primaryReads>0);
  const raw=f.sql.prepare('SELECT envelope FROM updater_provider_operations WHERE operation_id=?').get('updater-self-control').envelope;assert.ok(!raw.includes('highestUpdaterSequence'));
 }finally{f.sql.close();}
});
test('single encrypted CAS reserves only one candidate; all mutations require external fence and independent primary idle evidence',async()=>{
 const f=await fixture();try{
  await f.executor.initialize(f.capability,{...f.input(0,'bootstrap'),installed:{updaterVersion:'1.0.0',stateSchema:7,highestUpdaterSequence:1}});
  const wrongSchema=structuredClone(f.releases[1].manifest);wrongSchema.compatibility.stateSchema.max=8;wrongSchema.targetStateSchema=8;await assert.rejects(f.executor.admit(f.capability,{requestId:'schema',...await f.resign(wrongSchema)}),/updater-state-migration-required/);
  const wrongKind=structuredClone(f.releases[1].manifest);wrongKind.kind='application';await assert.rejects(f.executor.admit(f.capability,{requestId:'kind',...await f.resign(wrongKind)}),/updater-kind/);
  const wrongSource=structuredClone(f.releases[1].manifest);wrongSource.repository.id=99;await assert.rejects(f.executor.admit(f.capability,{requestId:'source',...await f.resign(wrongSource)}),/updater-source/);
  f.fence(false);await assert.rejects(f.executor.admit(f.capability,f.input(1,'denied')),/external-fence/);f.fence(true);
  f.sql.exec("INSERT INTO updater_job_holds VALUES('held','fixture','old',0,NULL,'active')");await assert.rejects(f.executor.admit(f.capability,f.input(1,'held')),/not-idle/);f.sql.exec("UPDATE updater_job_holds SET state='released'");
  f.sql.exec("UPDATE updater_maintenance SET state='closed'");await assert.rejects(f.executor.admit(f.capability,f.input(1,'closed')),/not-idle/);f.sql.exec("UPDATE updater_maintenance SET state='open'");
  const app=JSON.parse(f.sql.prepare('SELECT state_json FROM updater_state').get().state_json);app.job={status:'reconciling',operation:{id:'old'}};f.sql.prepare('UPDATE updater_state SET state_json=?').run(JSON.stringify(app));await assert.rejects(f.executor.admit(f.capability,f.input(1,'active')),/not-idle/);app.job=null;f.sql.prepare('UPDATE updater_state SET state_json=?').run(JSON.stringify(app));
  const requests=[f.input(1,'one'),f.input(2,'two')],outcomes=await Promise.allSettled(requests.map(r=>f.executor.admit(f.capability,r)));assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const winner=outcomes.findIndex(r=>r.status==='fulfilled'),requestId=requests[winner].requestId;await f.stage(winner+1,requestId);f.drift(true);await assert.rejects(f.executor.advance(f.capability,{requestId}),/secret-drift/);assert.equal(f.puts,0);f.drift(false);
  await f.executor.advance(f.capability,{requestId});f.fence(false);await assert.rejects(f.executor.advance(f.capability,{requestId}),/external-fence/);assert.equal(f.puts,0);
 }finally{f.sql.close();}
});
test('16 MiB signed artifact stages in bounded chunk actions, with bounded SQL sealing and unchanged state schema',async()=>{
 const f=await fixture({large:true});try{
  await f.executor.admit(f.capability,f.input(1,'large'));assert.ok(await f.stage(1,'large')<16);const before=f.queries;await f.executor.advance(f.capability,{requestId:'large'});assert.ok(f.queries-before<40);assert.equal(f.puts,0);
  await assert.rejects(f.executor.writeChunk(f.capability,{requestId:'large',index:0,bytes:new Uint8Array(1)}),/self-upgrade-chunk/);
  await assert.rejects(f.executor.admit({},f.input(2,'unauthorized')),/unauthorized/);
  assert.equal((await f.executor.status(f.capability)).installed.stateSchema,7);
 }finally{f.sql.close();}
});
