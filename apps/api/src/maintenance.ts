import { admitExecutionScope, type ExecutionScope } from '../../updater/src/execution-scope.mjs';
import { signMaintenanceRequest } from '../../../packages/shared/src/updater/maintenance-auth.ts';
import { boundedUpdaterBytes } from '../../../packages/shared/src/updater/service-auth.ts';
import { HttpError } from './http-error.ts';

type Binding = {fetch(request:Request):Promise<Response>};
type Namespace = {idFromName(name:string):unknown;get(id:unknown):Binding};
export type MaintenanceEnv = {MAINTENANCE?:Binding;MAINTENANCE_APP_KEY?:string;MAINTENANCE_INSTALLATION_ID?:string};
export type ExecutionContext = {waitUntil(promise:Promise<unknown>):void};
type Transport = (input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
const transportKey = Symbol('maintenance-transport');
type Carrier = {[transportKey]?:Transport};
const unavailable = () => new HttpError(503,'Application maintenance is in progress or unavailable.');
const configured = (env:MaintenanceEnv) => Boolean(env.MAINTENANCE || env.MAINTENANCE_APP_KEY || env.MAINTENANCE_INSTALLATION_ID);
export function providerFetch(env?:MaintenanceEnv|object):Transport {
  const scoped = (env as Carrier|undefined)?.[transportKey];
  if (scoped) return scoped;
  if (env && configured(env as MaintenanceEnv)) throw unavailable();
  return (input,init)=>fetch(input,init);
}
export function bindProviderScope<T extends object>(config:T,env:MaintenanceEnv):T {
  const scoped = (env as Carrier)[transportKey];
  if(scoped) Object.defineProperty(config,transportKey,{value:scoped,enumerable:true});
  return config;
}

// Only explicit synchronous endpoint contracts qualify; 202 and unknown endpoints
// remain ambiguous. GET/HEAD and tokeninfo are read-only requests, not mutations.
function readonlyRequest(request:Request) {const u=new URL(request.url);return ['GET','HEAD'].includes(request.method) || (u.hostname==='www.googleapis.com'&&u.pathname==='/oauth2/v2/tokeninfo');}
async function confirmed(request:Request,response:Response):Promise<boolean> {
  const u=new URL(request.url);
  if (u.hostname==='www.googleapis.com' && /^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?$/.test(u.pathname) && response.status===308) return true;
  if (!response.ok || response.status===202) return false;
  if (u.hostname==='api.resend.com' && u.pathname==='/emails' && request.method==='POST' && response.status===200) {
    try {const value=await response.clone().json() as {id?:unknown};return typeof value.id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id);}catch{return false;}
  }
  if (u.hostname==='oauth2.googleapis.com' && u.pathname==='/token') return response.status===200;
  if (u.hostname==='www.googleapis.com' && /^\/(?:drive\/v3\/files|upload\/drive\/v3\/files|calendar\/v3\/)/.test(u.pathname)) return [200,201,204].includes(response.status);
  if (u.hostname==='discord.com' && /^\/api\/v10\/(?:oauth2|users|guilds|channels|applications|webhooks)\//.test(u.pathname)) return [200,201,204].includes(response.status);
  return false;
}
async function completedResponse(dispatch:Transport,input:RequestInfo|URL,init?:RequestInit,serviceKind?:string):Promise<Response> {
  const request=new Request(input,init);
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(45000)]);
  const response=await dispatch(new Request(request,{signal,redirect:'manual'}));
  // Media paths retain their existing tighter readers too; never unbounded clone/tee.
  const u=new URL(request.url),media=u.hostname.endsWith('discordapp.com')||u.hostname.endsWith('discordapp.net')||u.searchParams.get('alt')==='media';
  const maximum=serviceKind==='document'?(u.pathname.endsWith('/result')?16*1024*1024:6*1024*1024):serviceKind==='updater'?16384:serviceKind==='password'||serviceKind==='scheduler'?65536:media?8*1024*1024:1024*1024;
  const bytes=await boundedUpdaterBytes(response,maximum);
  const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
  return new Response([204,205,304].includes(response.status)?null:bytes,{status:response.status,statusText:response.statusText,headers});
}
function scopedTransport(scope:ExecutionScope,dispatch:Transport,serviceKind?:string):Transport {
  return (input,init) => {
    const request=new Request(input,init);
    // The pinned compute services have no app D1/provider credentials. Their
    // isolated queue/storage may continue, but later app work needs new admission.
    if (readonlyRequest(request)||serviceKind==='password'||serviceKind==='document') return scope.guard(()=>completedResponse(dispatch,request,undefined,serviceKind))();
    return scope.mutation('provider',()=>completedResponse(dispatch,request,undefined,serviceKind),async response=>{
      // These own-service methods return only after their bounded handler finishes.
      if(serviceKind==='scheduler'||serviceKind==='updater')return response.ok&&response.status!==202;
      return confirmed(request,response);
    })();
  };
}
function privateCore(env:Required<MaintenanceEnv>) {
  const capability={},proof=[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');
  let handle:{id:string;epoch:number}|undefined;
  const call=async(action:string,body:Record<string,unknown>)=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([(async()=>{
      const request=await signMaintenanceRequest(env.MAINTENANCE_APP_KEY,env.MAINTENANCE_INSTALLATION_ID,action,{...body,proof});
      if(controller.signal.aborted)throw unavailable();
      const response=await env.MAINTENANCE.fetch(new Request(request,{signal:controller.signal}));
      const bytes=await boundedUpdaterBytes(response,2048);
      if(!response.ok)throw unavailable();
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},10000);})]);}
    finally{clearTimeout(timer);controller.abort();}
  };
  const body=(actual:unknown,value:unknown)=>{if(actual!==capability||value!==handle||!handle)throw unavailable();return {permitId:handle.id,epoch:handle.epoch};};
  const core={
    async admit(actual:unknown,input:{permitId:string}){if(actual!==capability)throw unavailable();const result=await call('admit',input);if(result.status!=='admitted')return {status:'not-admitted'};if(!Number.isSafeInteger(result.epoch)||result.epoch<0)throw unavailable();handle=Object.freeze({id:input.permitId,epoch:result.epoch});return {status:'admitted',permit:handle};},
    release:(actual:unknown,value:unknown)=>call('release',body(actual,value)),
    recordAmbiguity:(actual:unknown,value:unknown,operationId:string,kind:string)=>call('ambiguity',{...body(actual,value),operationId,kind}),
    operationStatus:(actual:unknown,value:unknown,operationId:string)=>call('operation',{...body(actual,value),operationId}),
  };
  return {core,capability};
}
export async function runApplication<T,E extends MaintenanceEnv>(env:E,context:ExecutionContext|undefined,handler:(env:E,context:ExecutionContext|undefined)=>Promise<T>):Promise<T> {
  if(!configured(env)) return handler(env,context);
  if(!env.MAINTENANCE||!env.MAINTENANCE_APP_KEY||!env.MAINTENANCE_INSTALLATION_ID)throw unavailable();
  const {core,capability}=privateCore(env as Required<MaintenanceEnv>);
  const scope=await admitExecutionScope({core,capability});if(!scope)throw unavailable();
  const scoped={...env} as E&Carrier&{DB?:unknown;DOCUMENT_COMPUTE?:Binding;UPDATER?:Binding;PLATFORM_SCHEDULER?:Namespace;PASSWORD_COMPUTATION?:Namespace};
  delete scoped.MAINTENANCE;delete scoped.MAINTENANCE_APP_KEY;delete scoped.MAINTENANCE_INSTALLATION_ID;
  scoped[transportKey]=scopedTransport(scope,(input,init)=>fetch(input,init));
  if(scoped.DB)scoped.DB=scope.wrapD1(scoped.DB);
  for(const name of ['DOCUMENT_COMPUTE','UPDATER'] as const){const original=scoped[name];if(original)scoped[name]={fetch:request=>scopedTransport(scope,input=>original.fetch(new Request(input)),name==='UPDATER'?'updater':'document')(request)};}
  for(const name of ['PLATFORM_SCHEDULER','PASSWORD_COMPUTATION'] as const){const original=scoped[name];if(original)scoped[name]={idFromName:n=>original.idFromName(n),get:key=>({fetch:request=>scopedTransport(scope,input=>original.get(key).fetch(new Request(input)),name==='PLATFORM_SCHEDULER'?'scheduler':'password')(request)})};}
  const result=scope.run(()=>handler(scoped,{waitUntil:promise=>scope.waitUntil(promise)}));
  if(context)context.waitUntil(scope.done);
  else {try{return await result;}finally{await scope.done;}}
  return result;
}
