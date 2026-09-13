import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createWriterFence } from '../apps/updater/src/writer-fence.mjs';
import { createArtifactStore, ARTIFACT_CHUNK_BYTES } from '../apps/updater/src/artifact-store.mjs';
import { createCheckpointCipher } from '../apps/updater/src/checkpoint.mjs';
import { createApplicationVerifier,sha256,signedBytes } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
const encode = value => new TextEncoder().encode(value);
async function fixture(t, size=0) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('../apps/updater/state/0002_updater_artifacts.sql',import.meta.url),'utf8'));
 let queries=0; const database={prepare(sql){let args=[];return{bind(...values){args=values;return this;},async first(){queries++;return db.prepare(sql).get(...args)??null;},async all(){queries++;return{results:db.prepare(sql).all(...args)}}}}};
 const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),trust={product:'LancerLogin',channel:'development',keyId:'synthetic',repository:{id:1,owner:'synthetic',name:'fence'},publicKey:new Uint8Array(await crypto.subtle.exportKey('raw',keys.publicKey))};
 const apiBytes=size?new Uint8Array(size).fill(32):encode('/* synthetic reviewed fence fixture: no real credentials */ export default {}'),dashboard=packDashboard([{path:'_worker.js',bytes:encode('export default {}')},{path:'index.html',bytes:encode('Synthetic')}]);
 const artifacts=await Promise.all([['api.mjs','api',apiBytes],['dashboard.tar','dashboard',dashboard]].map(async([name,role,bytes])=>({name,role,bytes:bytes.length,sha256:await sha256(bytes)})));
 const manifest={format:1,kind:'application',...Object.fromEntries(['product','channel','keyId','repository'].map(k=>[k,trust[k]])),sequence:1,version:'1.0.0',sourceCommit:'a'.repeat(40),minimumUpdaterVersion:'1.0.0',compatibility:{installedVersion:{min:'1.0.0',max:'1.0.0'},installedSchema:{min:0,max:0},apiVersion:1,apiSchema:{min:0,max:0},frontendApi:{min:1,max:1}},targetSchema:0,codeRollback:'compatible',artifacts,migrations:[]};
 const manifestBytes=encode(JSON.stringify(manifest)),signatureBytes=new Uint8Array(await crypto.subtle.sign('Ed25519',keys.privateKey,signedBytes(manifestBytes))),release={manifestBytes,signatureBytes};
 const pins={installationId:'synthetic-fence',applicationDatabaseId:crypto.randomUUID(),accountId:'b'.repeat(32),worker:'synthetic-api',maintenanceService:'synthetic-updater',workerSettings:{compatibility_date:'2026-09-04',compatibility_flags:[]},nonsecretBindings:[],secretBindings:[{name:'MAINTENANCE_APP_KEY',type:'secret_text'}]};
 pins.nonsecretBindings=[{name:'DB',type:'d1',id:pins.applicationDatabaseId},{name:'MAINTENANCE',type:'service',service:pins.maintenanceService},{name:'MAINTENANCE_INSTALLATION_ID',type:'plain_text',text:pins.installationId},{name:'RELEASE_VERSION',type:'plain_text',text:'1.0.0'}];
 const adoption={...Object.fromEntries(['installationId','applicationDatabaseId','accountId','worker','maintenanceService'].map(k=>[k,pins[k]])),recordSha256:'c'.repeat(64),contract:'exclusive-writers-fenced-adoption-v1'},coverage=[{apiSha256:artifacts[0].sha256,protocol:'maintenance-v1',entryPoints:['http','scheduled','scheduler-fetch','scheduler-alarm']}];
 const store=createArtifactStore({database,installationId:pins.installationId,cipher:await createCheckpointCipher(new Uint8Array(32).fill(8),pins.installationId)}),artifactId=`${await sha256(manifestBytes)}:api.mjs`;
 await store.begin({artifactId,bytes:apiBytes.length,digest:artifacts[0].sha256});for(let offset=0;offset<apiBytes.length;offset+=ARTIFACT_CHUNK_BYTES)await store.writeChunk(artifactId,offset/ARTIFACT_CHUNK_BYTES,apiBytes.slice(offset,offset+ARTIFACT_CHUNK_BYTES));await store.seal(artifactId);
 const expected={installationId:pins.installationId,applicationDatabaseId:pins.applicationDatabaseId,epoch:1,jobId:crypto.randomUUID(),operationId:crypto.randomUUID(),holdId:crypto.randomUUID()};
 const state={versionId:crypto.randomUUID(),deploymentId:'synthetic-deployment',settings:{...pins.workerSettings,bindings:[...pins.nonsecretBindings,...pins.secretBindings]},bytes:apiBytes,redirect:false,oversize:false,held:false,calls:0};
 const config={pins,adoption,coverage,token:'synthetic-cloudflare-read-token',store,verifier:createApplicationVerifier(trust),withAuthority:async(request,callback)=>{state.held=true;try{return await callback({...request,currentRelease:release,priorRelease:release})}finally{state.held=false}},fetch:async(url,options)=>{state.calls++;assert.equal(state.held,true);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${pins.accountId}/workers/scripts/${pins.worker}/`));assert.equal(options.headers.Authorization,'Bearer synthetic-cloudflare-read-token');if(state.redirect)return new Response(null,{status:302,headers:{location:'https://attacker.invalid'}});if(state.oversize)return new Response(new Uint8Array(262145));if(url.endsWith('/content/v2'))return new Response(state.bytes);let result;if(url.endsWith('/deployments'))result={deployments:[{id:state.deploymentId,versions:[{version_id:state.versionId,percentage:100}]}]};else if(url.includes('/versions/'))result={id:state.versionId};else if(url.endsWith('/settings'))result=state.settings;else throw Error('unexpected');return Response.json({success:true,result});}};
 return{db,store,config,state,expected,release,manifest,keys,queries:()=>queries,prepare:()=>createWriterFence(config).prepare(expected),run:()=>createWriterFence(config).withWriterFence(expected,evidence=>{assert.equal(state.held,true);return evidence})};
}
test('bounded preflight verifies actual bytes once; use rereads deployment/configuration and accepts new holds, never drift',async t=>{
 const f=await fixture(t);await assert.rejects(f.run(),/writer-fence-preparation/);assert.equal((await f.prepare()).outcome,'pending');assert.equal(f.state.calls,0);assert.equal((await f.prepare()).outcome,'ready');assert.equal(f.state.calls,5);
 const first=await f.run();assert.equal(f.state.calls,8);assert.equal(first.holdId,f.expected.holdId);assert.equal(first.configurationSha256.length,64);assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM updater_provider_operations').all()).includes('synthetic-deployment'));
 f.expected.holdId=crypto.randomUUID();const second=await f.run();assert.equal(second.holdId,f.expected.holdId);assert.equal(second.configurationSha256,first.configurationSha256);assert.equal(f.state.calls,11);f.state.deploymentId='different-deployment';await assert.rejects(f.run(),/writer-fence-drift/);
});
test('signature alone cannot establish coverage/adoption; distinct prior coverage and corrupt retained/deployed bytes fail',async t=>{
 const f=await fixture(t);assert.throws(()=>createWriterFence({...f.config,adoption:undefined}));assert.throws(()=>createWriterFence({...f.config,coverage:[]}));
 const prior=structuredClone(f.manifest);prior.artifacts[0].sha256='d'.repeat(64);const manifestBytes=encode(JSON.stringify(prior)),signatureBytes=new Uint8Array(await crypto.subtle.sign('Ed25519',f.keys.privateKey,signedBytes(manifestBytes)));const authority=f.config.withAuthority;
 f.config.withAuthority=(request,callback)=>authority(request,value=>callback({...value,priorRelease:{manifestBytes,signatureBytes}}));await assert.rejects(f.prepare(),/writer-fence-coverage/);f.config.withAuthority=authority;
 const original=f.config.store;f.config.store={...original,read:async()=>encode('bad retained prior')};await assert.rejects(f.prepare());f.config.store=original;
 assert.equal((await f.prepare()).outcome,'pending');f.state.bytes=encode('tampered deployed code');await assert.rejects(f.prepare());
});
test('configuration, redirects, oversized metadata and authority reject without dispatch',async t=>{
 const f=await fixture(t);await f.prepare();f.state.redirect=true;await assert.rejects(f.prepare(),/writer-fence-provider/);assert.equal(f.state.calls,1);f.state.redirect=false;f.state.oversize=true;await assert.rejects(f.prepare(),/writer-fence-size/);f.state.oversize=false;
 f.state.settings.bindings=f.state.settings.bindings.filter(x=>x.name!=='MAINTENANCE');await assert.rejects(f.prepare(),/writer-fence-configuration/);
 const before=f.state.calls;f.config.withAuthority=async(request,callback)=>callback({...request,epoch:2});await assert.rejects(f.prepare(),/writer-fence-authority/);assert.equal(f.state.calls,before);
});
test('maximum16MiB retained artifact uses paged D1 reads only during preflight',async t=>{
 const f=await fixture(t,16*1024*1024);let before=f.queries();assert.equal((await f.prepare()).outcome,'pending');assert.equal(f.queries()-before,15);assert.equal(f.state.calls,0);
 before=f.queries();assert.equal((await f.prepare()).outcome,'ready');assert.equal(f.queries()-before,2);assert.equal(f.state.calls,5);
 before=f.queries();await f.run();assert.equal(f.queries()-before,1);assert.equal(f.state.calls,8);
});
