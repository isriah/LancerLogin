import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { updaterConfiguration } from '../apps/updater/worker-config.mjs';
import { createUpdaterRuntime } from '../apps/updater/runtime.mjs';
import { recoveryCredentialDigest } from '../apps/updater/recovery-service.mjs';
import { sha256,signedBytes } from '../packages/shared/src/updater/application-release.mjs';
import { packDashboard } from '../packages/shared/src/updater/dashboard-archive.mjs';
import { snapshotCatalog } from '../apps/updater/src/snapshot-catalog.mjs';
import { bootstrapAdoption } from './updater-bootstrap-adoption.mjs';
const encode=x=>new TextEncoder().encode(x);
function binding(db,observed=()=>{}){const native=new WeakMap();return {withSession(mode){assert.equal(mode,'first-primary');return this;},prepare(sql){let args=[];const statement={bind(...values){args=values;return this;},async first(){const result=db.prepare(sql).get(...args)??null;observed(sql);return result;},async all(){const result={results:db.prepare(sql).all(...args)};observed(sql);return result;},async run(){const result=db.prepare(sql).run(...args);observed(sql);return result;}};native.set(statement,()=>db.prepare(sql).run(...args));return statement;},async batch(statements){db.exec('BEGIN');try{for(const statement of statements)native.get(statement)();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}};}
export async function fixture(t,{largeDashboard=false}={}){
  const databases=Array.from({length:3},()=>new DatabaseSync(':memory:'));t.after(()=>databases.forEach(db=>db.close()));const [application,updater,validation]=databases;
  for(const file of readdirSync(new URL('../apps/updater/state/',import.meta.url)))updater.exec(readFileSync(new URL(`../apps/updater/state/${file}`,import.meta.url),'utf8'));
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),publicKey=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
  const config={format:1,pins:{installationId:'synthetic-entrypoint',accountId:'a'.repeat(32),worker:'synthetic-api',pagesProject:'synthetic-pages',productionBranch:'main',applicationDatabaseId:crypto.randomUUID(),updaterDatabaseId:crypto.randomUUID(),validationDatabaseId:crypto.randomUUID(),workerSettings:{compatibility_date:'2026-09-04',compatibility_flags:[]},nonsecretBindings:[],apiOrigin:'https://api.example.invalid',dashboardOrigin:'https://app.example.invalid',recoveryOrigin:'https://recovery.example.invalid'},trust:{product:'LancerLogin',channel:'development',repository:{id:123,owner:'synthetic',name:'entrypoint'},keyId:'synthetic',publicKey:[...publicKey].map(x=>x.toString(16).padStart(2,'0')).join('')}};
  config.pins.nonsecretBindings=[{name:'DB',type:'d1',id:config.pins.applicationDatabaseId},{name:'RELEASE_VERSION',type:'plain_text',text:'1.0.0'}];
  const state={badCode:false,badSettings:false,reads:0,publicReads:0,queries:0,afterQuery:()=>{}},observed=sql=>{state.queries++;state.afterQuery(sql);};
  const credential='cd'.repeat(32),env={UPDATER_CONFIG:JSON.stringify(config),APPLICATION_DB:binding(application,observed),UPDATER_DB:binding(updater,observed),VALIDATION_DB:binding(validation,observed),CHECKPOINT_KEY:'17'.repeat(32),APP_HMAC:'ab'.repeat(32),MAINTENANCE_HMAC:'ef'.repeat(32),GITHUB_TOKEN:'synthetic-github-token',CLOUDFLARE_TOKEN:'synthetic-cloudflare-token',RECOVERY_CREDENTIAL_SHA256:await recoveryCredentialDigest(credential,config.pins.installationId)};
  for(const object of [...snapshotCatalog.objects.filter(o=>o.type==='table'&&o.name!=='sqlite_sequence'),...snapshotCatalog.objects.filter(o=>o.type!=='table'&&o.sql)])application.exec(object.sql);
  for(const entry of snapshotCatalog.ledger)application.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(entry.id);
  const dashboardFiles=[{path:'_worker.js',bytes:encode('export default {}')},{path:'index.html',bytes:encode('synthetic')}];
  if(largeDashboard)for(let i=0;i<2046;i++)dashboardFiles.push({path:`assets/file-${String(i).padStart(4,'0')}.js`,bytes:new Uint8Array(i===0?8388608:i===1?7337984:0)});
  const files=new Map([['api.mjs',encode('export default {}')],['dashboard.tar',packDashboard(dashboardFiles)]]);
  for(const entry of snapshotCatalog.ledger)files.set(entry.id,new Uint8Array(readFileSync(new URL(`../apps/api/migrations/${entry.id}`,import.meta.url))));
  const artifacts=await Promise.all([...files].map(async([name,bytes])=>({name,role:name.endsWith('.sql')?'migration':name.endsWith('.tar')?'dashboard':'api',bytes:bytes.length,sha256:await sha256(bytes)})));
  const manifest={format:1,kind:'application',product:config.trust.product,channel:config.trust.channel,repository:config.trust.repository,keyId:config.trust.keyId,sequence:1,version:'1.0.0',sourceCommit:'a'.repeat(40),minimumUpdaterVersion:'1.0.0',targetSchema:49,codeRollback:'compatible',artifacts,migrations:snapshotCatalog.ledger.map((x,i)=>({...x,artifact:x.id,fromSchema:i,toSchema:i+1})),compatibility:{installedVersion:{min:'1.0.0',max:'1.0.0'},installedSchema:{min:49,max:49},apiVersion:1,apiSchema:{min:49,max:49},frontendApi:{min:1,max:1}}};
  const manifestBytes=encode(JSON.stringify(manifest)),signatureBytes=new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,signedBytes(manifestBytes))),capability={};
  const deployment={id:'initial-api',versions:[{version_id:'initial-version',percentage:100}]},pageConfig={compatibility_date:'2026-09-04',env_vars:{PRIVATE_PROXY:{type:'secret_text',value:'must-not-be-retained'}}};
  const provider=x=>Response.json({success:true,result:x});
  const fetcher=async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');state.reads++;const path=new URL(url).pathname;
   if(new URL(url).origin===config.pins.dashboardOrigin){state.publicReads++;assert.equal(options.headers.Authorization,undefined);const file=dashboardFiles.find(file=>file.path===(path==='/'?'index.html':path.slice(1)));assert.ok(file);return new Response(file.bytes);}
   assert.equal(options.headers.Authorization,'Bearer synthetic-cloudflare-token');
   if(path.endsWith('/settings'))return provider({...config.pins.workerSettings,bindings:state.badSettings?[]:config.pins.nonsecretBindings});
   if(path.endsWith('/content/v2'))return new Response(state.badCode?encode('tamper'):files.get('api.mjs'));
   if(path.endsWith('/versions/initial-version'))return provider({id:'initial-version'});
   if(path.endsWith('/deployments'))return provider({deployments:[deployment]});
   if(path.endsWith('/synthetic-pages'))return provider({name:config.pins.pagesProject,production_branch:'main',source:null,deployment_configs:{production:pageConfig},canonical_deployment:{id:'initial-pages',environment:'production',latest_stage:{name:'deploy',status:'success'},deployment_trigger:{metadata:{branch:'main',commit_hash:manifest.sourceCommit,commit_message:'LancerLogin updater '+await sha256(manifestBytes)}}}});
   throw Error('unexpected provider endpoint');
  };
  const options={...updaterConfiguration(env),bootstrapCapability:capability,fetch:fetcher},runtime=await createUpdaterRuntime(options);
  const input={releaseId:1,manifestBytes,signatureBytes,updaterVersion:'1.0.0',artifacts:files,adoption:await bootstrapAdoption(config.pins,{apiDeploymentId:'initial-api',apiVersionId:'initial-version',pagesDeploymentId:'initial-pages',config:pageConfig})};
  return {env,config,updater,application,credential,state,input,runtime,capability,options,files,async initialize(){let result;for(let i=0;i<160;i++){result=await runtime.initialize(capability,input);if(result.outcome==='initialized')break;}assert.equal(result.outcome,'initialized');}};
}
