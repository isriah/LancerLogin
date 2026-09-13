import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { build } from 'esbuild';
import {generateKeyPairSync,sign} from 'node:crypto';
import {encryptIntegration} from '../apps/api/src/integration-crypto.ts';
import { documentationAvailable } from '../packages/shared/src/release-capabilities.ts';
import { configureModules,moduleSnapshot,setModuleGrants,getModuleGrants,validateModuleBackup } from '../apps/api/src/platform-modules.ts';
import worker from '../apps/api/src/index.ts';
import { admitUpload,advanceUpload } from '../apps/api/src/documentation-upload.ts';
import { driveCopyRoute } from '../apps/api/src/documentation-drive-intake.ts';
import { googleCapability } from '../apps/api/src/google-connection.ts';
import { submitMemberDocumentationNote } from '../apps/api/src/public-documentation.ts';

test('shipped profile blocks documentation and preserves dormant grants and complete backup metadata',async()=>{
 assert.equal(documentationAvailable,false);const raw=new DatabaseSync(':memory:');
 try{
  for(const file of readdirSync(new URL('../apps/api/migrations/',import.meta.url)).sort())raw.exec(readFileSync(new URL('../apps/api/migrations/'+file,import.meta.url),'utf8'));
  raw.exec("INSERT INTO installations(id,created_at,auth_mode) VALUES('primary','2026-01-01','local'); INSERT INTO users(id,installation_id,local_username,role,created_at) VALUES('admin','primary','admin','admin','2026-01-01'); INSERT INTO platform_module_configuration VALUES('primary',1,1,1); INSERT INTO platform_module_grants VALUES('primary','admin',1,1)");
  const db={prepare(sql){let args=[];return {bind(...a){args=a;return this},async first(){return raw.prepare(sql).get(...args)??null},async run(){return {meta:{changes:Number(raw.prepare(sql).run(...args).changes)}}}}},async batch(stmts){raw.exec('BEGIN');try{const result=[];for(const s of stmts)result.push(await s.run());raw.exec('COMMIT');return result}catch(e){raw.exec('ROLLBACK');throw e}}};
  assert.deepEqual((await moduleSnapshot(db,'primary','admin')).capabilities,['hours.manage']);assert.equal(raw.prepare('SELECT documentation_enabled d FROM platform_module_configuration').get().d,1);
  await assert.rejects(()=>configureModules(db,'primary','admin',{enabled:['hour-tracking','activity-documentation'],revision:1}),/unavailable/);
  await assert.rejects(()=>setModuleGrants(db,'primary','admin','admin',{capabilities:['documentation.manage']}),/unavailable/);
  await setModuleGrants(db,'primary','admin','admin',{capabilities:['hours.manage']});assert.equal(raw.prepare('SELECT documentation_manage d FROM platform_module_grants').get().d,1);assert.deepEqual((await getModuleGrants(db,'primary','admin','admin')).capabilities,['hours.manage']);
  validateModuleBackup({users:[{id:'admin',installation_id:'primary'}],platform_module_configuration:[{installation_id:'primary',hours_enabled:1,documentation_enabled:1,revision:1}],platform_module_grants:[{installation_id:'primary',user_id:'admin',hours_manage:1,documentation_manage:1}]});
  await configureModules(db,'primary','admin',{enabled:[],revision:1});assert.deepEqual(raw.prepare('SELECT hours_enabled h,documentation_enabled d FROM platform_module_configuration').get(),Object.assign(Object.create(null),{h:0,d:0}));
  await configureModules(db,'primary','admin',{enabled:['hour-tracking'],revision:2});assert.deepEqual((await moduleSnapshot(db,'primary','admin')).capabilities,['hours.manage']);
 }finally{raw.close()}
});
test('documentation HTTP and continuation admission stop before database/provider use',async()=>{
 const env={APP_MODE:'configured',ALLOWED_ORIGIN:'https://app.example.test',DB:{prepare(){throw Error('database reached')}},DOCUMENT_COMPUTE:{fetch(){throw Error('provider reached')}}};
 for(const path of ['/admin/document-compute/proofs/status','/admin/integrations/discord/attachment-proofs/status','/public/documentation/activities','/public/documentation/uploads','/admin/documentation/claims','/admin/connections/google/storage','/admin/connections/google/drive/picker'])assert.equal((await worker.fetch(new Request('https://api.example.test'+path),env)).status,404);
 for(const call of [()=>admitUpload(env,{},{}),()=>advanceUpload(env,{},'advance'),()=>driveCopyRoute(new Request('https://api.example.test/'),env,{}),()=>googleCapability(env,'drive'),()=>submitMemberDocumentationNote(env.DB,'primary',{})])await assert.rejects(call,/unavailable in this release/);
});
test('normal production bundling keeps documentation unavailable without test substitutions',async()=>{
 const output=await build({stdin:{contents:"export {documentationAvailable} from './packages/shared/src/release-capabilities.ts'",resolveDir:process.cwd()},bundle:true,format:'esm',write:false,platform:'browser'});
 const module=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));assert.equal(module.documentationAvailable,false);
});
test('signed stale documentation and attachment-proof Discord interactions never dispatch background work',async()=>{
 const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'),key='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
 const encrypted=await encryptIntegration({publicKey,applicationId:'123456789012345679',guildId:'123456789012345680'},key);
 const env={APP_MODE:'configured',ALLOWED_ORIGIN:'https://app.example.test',INTEGRATION_KEY:key,DB:{prepare(sql){assert.match(sql,/encrypted_integrations/);return {bind(){return this},async first(){return {...encrypted,enabled:1,verifiedAt:'2026-01-01'}}}}}};
 for(const data of [{name:'attachment-proof'},{custom_id:'llap:stale'},{name:'activity-file'},{custom_id:'lldf:stale'},{name:'activity-note'}]){
  const raw=JSON.stringify({type:data.name?2:3,data,guild_id:'123456789012345680',member:{user:{id:'123456789012345678'}}}),timestamp=String(Math.floor(Date.now()/1000));
  const response=await worker.fetch(new Request('https://api.example.test/discord/interactions',{method:'POST',headers:{'x-signature-timestamp':timestamp,'x-signature-ed25519':sign(null,Buffer.from(timestamp+raw),keys.privateKey).toString('hex')},body:raw}),env,{waitUntil(){assert.fail('background dispatch')}});
  assert.equal(response.status,200);assert.match((await response.json()).data.content,/unavailable in this release/);
 }
});
