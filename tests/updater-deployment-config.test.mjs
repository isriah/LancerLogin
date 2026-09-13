import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { generateUpdaterDeployment } from '../scripts/generate-updater-deployment.mjs';

test('offline deployment package validates full runtime pins and exact Wrangler/service configuration',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ll-updater-config-'));t.after(()=>{const child=relative(resolve(tmpdir()),resolve(directory));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));return rm(directory,{recursive:true,force:true});});
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),publicKey=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('hex');
  const config={format:1,pins:{installationId:'synthetic-config',accountId:'a'.repeat(32),worker:'synthetic-api',pagesProject:'synthetic-pages',productionBranch:'main',applicationDatabaseId:crypto.randomUUID(),updaterDatabaseId:crypto.randomUUID(),validationDatabaseId:crypto.randomUUID(),workerSettings:{compatibility_date:'2026-09-04',compatibility_flags:[]},nonsecretBindings:[],apiOrigin:'https://api.example.invalid',dashboardOrigin:'https://app.example.invalid',recoveryOrigin:'https://recovery.example.invalid'},trust:{product:'LancerLogin',channel:'development',repository:{id:123,owner:'synthetic',name:'config'},keyId:'synthetic',publicKey}};
  config.pins.nonsecretBindings=[{name:'DB',type:'d1',id:config.pins.applicationDatabaseId},{name:'RELEASE_VERSION',type:'plain_text',text:'1.0.0'}];
  const input={config,updaterWorkerName:'synthetic-updater',compatibilityDate:'2026-09-04'},output=join(directory,'package');
  for(const invalid of [{...input,token:'never-accepted'},{...input,updaterWorkerName:config.pins.worker},{...input,compatibilityDate:'2026-02-31'},{...input,config:{...config,pins:{...config.pins,accountId:'invalid'}}},{...input,config:{...config,fencePolicy:{maintenanceService:'wrong-service'}}},{...input,config:{...config,pins:{...config.pins,validationDatabaseId:config.pins.applicationDatabaseId}}}])await assert.rejects(()=>generateUpdaterDeployment(invalid,output));
  const result=await generateUpdaterDeployment(input,output);assert.ok(result.bytes>1000);await assert.rejects(()=>generateUpdaterDeployment(input,output));
  const read=async file=>JSON.parse(await readFile(join(output,file),'utf8')),wrangler=await read('wrangler.json'),fragment=await read('application-bindings.review.json'),secrets=await read('required-secrets.review.json');
  assert.equal(wrangler.workers_dev,false);assert.equal(wrangler.preview_urls,false);assert.equal(wrangler.routes,undefined);assert.equal(wrangler.account_id,config.pins.accountId);assert.deepEqual(JSON.parse(wrangler.vars.UPDATER_CONFIG),config);
  assert.deepEqual(wrangler.d1_databases.map(x=>x.database_id),[config.pins.applicationDatabaseId,config.pins.updaterDatabaseId,config.pins.validationDatabaseId]);
  assert.deepEqual(fragment.services,[{binding:'UPDATER',service:'synthetic-updater',entrypoint:'ApplicationUpdates'},{binding:'MAINTENANCE',service:'synthetic-updater',entrypoint:'MaintenanceLifecycle'}]);
  assert.equal(fragment.vars.MAINTENANCE_INSTALLATION_ID,config.pins.installationId);assert.deepEqual(secrets.requiredSecretNames,['CHECKPOINT_KEY','GITHUB_TOKEN','CLOUDFLARE_TOKEN','APP_HMAC','MAINTENANCE_HMAC','RECOVERY_CREDENTIAL_SHA256']);assert.equal(secrets.applicationSecretMappings[0].name,'UPDATER_APP_KEY');
  const bundle=await readFile(join(output,'updater.mjs'),'utf8');for(const marker of ['11'.repeat(32),'22'.repeat(32),'33'.repeat(32),'44'.repeat(32),'offline-validation-only'])assert.ok(!JSON.stringify([wrangler,fragment,secrets,bundle]).includes(marker));
  // Installed Wrangler's parser/normalizer validates locally; no deploy/dry-run, auth lookup or network.
  process.env.WRANGLER_SEND_METRICS='false';const {unstable_readConfig}=await import('wrangler');const parsed=unstable_readConfig({config:join(output,'wrangler.json')},{hideWarnings:true});
  assert.equal(parsed.name,input.updaterWorkerName);assert.equal(parsed.d1_databases.length,3);assert.equal(parsed.main,join(output,'updater.mjs'));
  t.diagnostic(`offline ${result.bytes}-byte module; installed Wrangler parser accepted exact generated config`);
});
