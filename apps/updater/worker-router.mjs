import { createUpdaterRuntime } from './runtime.mjs';
import { createCheckpointCipher } from './src/checkpoint.mjs';
import { updaterConfiguration } from './worker-config.mjs';
const publicPaths=new Set(['/recovery','/recovery/session','/recovery/status','/recovery/advance','/recovery/retry-preparation','/recovery/recovery','/recovery/logout','/control','/control/exchange','/control/status','/control/advance','/control/retry-preparation','/control/logout']);
const appPaths=new Set(['status','check','start','control-grant','advance','retry-preparation','recovery'].map(x=>'/v1/'+x));
const maintenancePaths=new Set(['admit','release','ambiguity','operation'].map(x=>'/private/maintenance/'+x));
const reply=(status,error)=>Response.json({error},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function routeUpdater(env,surface,request){
  try{
    const url=new URL(request.url),paths=surface==='public'?publicPaths:surface==='application'?appPaths:surface==='maintenance'?maintenancePaths:null;
    if(!paths?.has(url.pathname)||url.search||url.hash||url.username||url.password||url.pathname.includes('%'))return reply(404,'Not found.');
    const config=updaterConfiguration(env),expectedOrigin=surface==='public'?config.pins.recoveryOrigin:surface==='application'?'https://updater.internal':'https://maintenance.internal';
    if(url.origin!==expectedOrigin||request.url!==expectedOrigin+url.pathname)return reply(404,'Not found.');
    // No public/private entrypoint can initialize, reset, or infer initial state.
    const db=config.bindings.updater,primary=db.withSession?db.withSession('first-primary'):db;
    const state=await primary.prepare("SELECT s.installation_id,p.envelope FROM updater_state s JOIN updater_provider_operations p ON p.installation_id=s.installation_id AND p.operation_id='runtime-bootstrap' WHERE s.id=1").first();
    if(state?.installation_id!==config.pins.installationId)return reply(503,'Updater initialization is unavailable.');
    const cipher=await createCheckpointCipher(config.secrets.checkpointKey,config.pins.installationId),bootstrap=await cipher.open('operation:runtime-bootstrap',JSON.parse(state.envelope));
    if(bootstrap.complete!==true)return reply(503,'Updater initialization is unavailable.');
    const runtime=await createUpdaterRuntime({...config,bootstrapCapability:{}});
    const target=surface==='public'?(url.pathname.startsWith('/recovery')?'recovery':'controls'):surface;
    return await runtime[target].fetch(request);
  }catch{return reply(503,'Updater is unavailable.');}
}
