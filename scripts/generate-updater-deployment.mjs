import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../packages/shared/src/updater/application-release.mjs';
import { updaterConfiguration } from '../apps/updater/worker-config.mjs';
import { createUpdaterRuntime } from '../apps/updater/runtime.mjs';
import { buildUpdaterWorker } from './build-updater-worker.mjs';
const check=ok=>{if(!ok)throw Error('updater-deployment-input');};
const denied=()=>{throw Error('offline-access-forbidden');};
const secretNames=['CHECKPOINT_KEY','GITHUB_TOKEN','CLOUDFLARE_TOKEN','APP_HMAC','MAINTENANCE_HMAC','RECOVERY_CREDENTIAL_SHA256'];
export async function generateUpdaterDeployment(input, output){
  input=structuredClone(input);
  check(input&&Object.keys(input).sort().join(',')==='compatibilityDate,config,updaterWorkerName');
  const {config,updaterWorkerName:name,compatibilityDate:date}=input;
  check(typeof name==='string'&&/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)&&name!==config?.pins?.worker);
  check(typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&new Date(date).toISOString().slice(0,10)===date);
  check(typeof output==='string'&&output.length>0);
  if(config?.fencePolicy)check(config.fencePolicy.maintenanceService===name);
  // Only constructor validation runs. Any future constructor I/O fails locally.
  const inert=()=>({prepare:denied,batch:denied});
  const options=updaterConfiguration({UPDATER_CONFIG:JSON.stringify(config),APPLICATION_DB:inert(),UPDATER_DB:inert(),VALIDATION_DB:inert(),CHECKPOINT_KEY:'11'.repeat(32),APP_HMAC:'22'.repeat(32),MAINTENANCE_HMAC:'33'.repeat(32),RECOVERY_CREDENTIAL_SHA256:'44'.repeat(32),GITHUB_TOKEN:'offline-validation-only',CLOUDFLARE_TOKEN:'offline-validation-only'});
  await createUpdaterRuntime({...options,bootstrapCapability:{},fetch:denied});
  const wrangler={name,main:'./updater.mjs',account_id:config.pins.accountId,compatibility_date:date,workers_dev:false,preview_urls:false,vars:{UPDATER_CONFIG:JSON.stringify(config)},d1_databases:[['APPLICATION_DB','applicationDatabaseId'],['UPDATER_DB','updaterDatabaseId'],['VALIDATION_DB','validationDatabaseId']].map(([binding,key])=>({binding,database_id:config.pins[key]}))};
  const application={services:[{binding:'UPDATER',service:name,entrypoint:'ApplicationUpdates'},{binding:'MAINTENANCE',service:name,entrypoint:'MaintenanceLifecycle'}],vars:{UPDATER_INSTALLATION_ID:config.pins.installationId,MAINTENANCE_INSTALLATION_ID:config.pins.installationId}};
  const secrets={updaterWorker:name,requiredSecretNames:secretNames,applicationWorker:config.pins.worker,applicationSecretMappings:[{name:'UPDATER_APP_KEY',sameValueAsUpdaterSecret:'APP_HMAC'},{name:'MAINTENANCE_APP_KEY',sameValueAsUpdaterSecret:'MAINTENANCE_HMAC'}]};
  const directory=resolve(output);await mkdir(directory); // Atomic new-directory claim; never reuse an existing directory.
  const built=await buildUpdaterWorker(join(directory,'updater.mjs'));
  for(const [file,value]of [['wrangler.json',wrangler],['application-bindings.review.json',application],['required-secrets.review.json',secrets]])await writeFile(join(directory,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  return {bytes:built.bytes};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{check(process.argv.length===6&&process.argv[2]==='--input'&&process.argv[4]==='--output');const bytes=new Uint8Array(await readFile(process.argv[3]));check(bytes.length<=131072);await generateUpdaterDeployment(parseStrictJson(bytes),process.argv[5]);process.stdout.write('Generated offline updater review package. Public routing remains disabled.\n');}
  catch{process.stderr.write('Updater configuration generation failed. Check trusted input and use a new output directory.\n');process.exitCode=1;}
}
