import { hashPassword, verifyPassword } from './runtime-security.ts';
import { HttpError } from './http-error.ts';

export interface PasswordNamespace { idFromName(name:string):unknown; get(id:unknown):{fetch(request:Request):Promise<Response>}; }
export interface PasswordEnvironment { SESSION_KEY?:string; PASSWORD_COMPUTATION_MODE?:string; PASSWORD_COMPUTATION?:PasswordNamespace; }
type HashPurpose = 'first-admin'|'user-create'|'password-reset';
type Input = {operation:'hash';purpose:HashPurpose;password:string}|{operation:'verify';purpose:'local-login';password:string;encoded:string|null};
type Envelope = Input & {version:2;installationId:'primary';requestId:string;issuedAt:number;expiresAt:number};
// The existing API accepts a 256 KiB JSON request. Re-encoding its password
// plus fixed internal metadata must fit without narrowing supported passwords.
const maxPasswordBytes=262144,maxEnvelopeBytes=maxPasswordBytes+2048,deadlineMs=5000,clockSkewMs=1000;
const encoder=new TextEncoder(),domain='LancerLogin/password-computation/v1\n';
const reasonHeader='x-ll-password-error';
const internalReasons=['mode','route','signature','body','authorization','envelope','envelope-time','replay-capacity','gate','computation','expired-result'] as const;
type InternalReason=typeof internalReasons[number];
const internalFailure=(status:number,reason:InternalReason)=>new Response(null,{status,headers:{'content-type':'application/json','cache-control':'no-store',[reasonHeader]:reason}});
const unavailable=()=>new HttpError(503,'Password service unavailable; try again later');
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,any>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
function decode(value:string){const raw=atob(value.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(value.length/4)*4,'='));return Uint8Array.from(raw,c=>c.charCodeAt(0));}
export function canonicalPasswordHash(value:unknown):value is string {
  if(typeof value!=='string'||!/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(value))return false;
  const parts=value.split('$');return base64(decode(parts[4]))===parts[4]&&base64(decode(parts[5]))===parts[5];
}
async function authorizationKey(env:PasswordEnvironment){
  if(!env.SESSION_KEY||!/^[A-Za-z0-9_-]{43,172}$/.test(env.SESSION_KEY))throw unavailable();
  const bytes=decode(env.SESSION_KEY);if(bytes.length<32)throw unavailable();
  return crypto.subtle.importKey('raw',Uint8Array.from(bytes).buffer,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
async function signedBytes(body:string){const digest=await crypto.subtle.digest('SHA-256',encoder.encode(body));return encoder.encode(domain+base64(new Uint8Array(digest)));}
async function boundedText(response:Request|Response,limit:number):Promise<string>{
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw unavailable();
  if(!response.body)throw unavailable();const reader=response.body.getReader();const parts:Uint8Array[]=[];let total=0;let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),deadlineMs);});
  try{for(;;){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;total+=value.byteLength;if(total>limit)throw unavailable();parts.push(value);}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{clearTimeout(timer);reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function validInput(value:Record<string,any>):boolean {
  if(typeof value.password!=='string'||encoder.encode(value.password).byteLength>maxPasswordBytes)return false;
  return value.operation==='hash'?['first-admin','user-create','password-reset'].includes(value.purpose)&&value.password.length>=12
    :value.operation==='verify'&&value.purpose==='local-login'&&(value.encoded===null||canonicalPasswordHash(value.encoded));
}
/** Internal binding protocol only: no route in the public API forwards it. */
export async function passwordComputationRequest(env:PasswordEnvironment,input:Input):Promise<Request>{
  if(!validInput(input))throw unavailable();
  const issuedAt=Date.now();
  const envelope:Envelope={version:2,installationId:'primary',requestId:crypto.randomUUID(),issuedAt,expiresAt:issuedAt+deadlineMs,...input};
  const body=JSON.stringify(envelope);if(encoder.encode(body).byteLength>maxEnvelopeBytes)throw unavailable();
  const signature=await crypto.subtle.sign('HMAC',await authorizationKey(env),await signedBytes(body));
  return new Request('https://password.internal/compute',{method:'POST',headers:{'content-type':'application/json','x-ll-password-auth':base64(new Uint8Array(signature))},body});
}
let dummyHash:Promise<string>|undefined;
async function inlineVerify(password:string,encoded:string|null){return verifyPassword(password,encoded??await(dummyHash??=hashPassword('LancerLogin timing equalizer',new Uint8Array(16))));}
function durable(env:PasswordEnvironment){if(env.PASSWORD_COMPUTATION_MODE===undefined||env.PASSWORD_COMPUTATION_MODE==='inline')return false;if(env.PASSWORD_COMPUTATION_MODE!=='durable'||!env.PASSWORD_COMPUTATION)throw unavailable();return true;}
async function compute(env:PasswordEnvironment,input:Input):Promise<string|boolean>{
  let category='request';let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{category='deadline';controller.abort();reject(unavailable());},deadlineMs);});
  try{return await Promise.race([(async()=>{
    const request=await passwordComputationRequest(env,input),envelope:Envelope=JSON.parse(await request.clone().text());
    category='binding-fetch';const response=await env.PASSWORD_COMPUTATION!.get(env.PASSWORD_COMPUTATION!.idFromName('primary')).fetch(new Request(request,{signal:controller.signal}));
    if(!response.ok){const reason=response.headers.get(reasonHeader);category=internalReasons.some(value=>value===reason)?'internal-'+reason:'internal-unclassified';throw unavailable();}category='response';const result:unknown=JSON.parse(await boundedText(response,512));
    controller.signal.throwIfAborted();if(Date.now()>=envelope.expiresAt||!object(result)||!exact(result,['version','requestId','operation','value'])||result.version!==2||result.requestId!==envelope.requestId||result.operation!==input.operation||(input.operation==='hash'?!canonicalPasswordHash(result.value):typeof result.value!=='boolean'))throw unavailable();
    return result.value;
  })(),deadline]);}catch{console.warn('password-computation failure',category);throw unavailable();}finally{clearTimeout(timer);}
}
export async function hashApiPassword(env:PasswordEnvironment,password:string,purpose:HashPurpose):Promise<string>{return durable(env)?await compute(env,{operation:'hash',purpose,password}) as string:hashPassword(password);}
export async function verifyApiPassword(env:PasswordEnvironment,password:string,encoded:string|null):Promise<boolean>{return durable(env)?await compute(env,{operation:'verify',purpose:'local-login',password,encoded}) as boolean:inlineVerify(password,encoded);}

// One computation per isolate, plus two short-lived waiters. This bounds
// scrypt working memory even if an internal caller obtains another object ID.
export class PasswordComputationGate {
  private working=false;
  private waiters:{start:()=>void;cancel:()=>void}[]=[];
  async enter(expiresAt:number){
    if(Date.now()>=expiresAt)throw unavailable();if(!this.working){this.working=true;return;}
    if(this.waiters.length>=2)throw unavailable();
    await new Promise<void>((resolve,reject)=>{
      let timer:ReturnType<typeof setTimeout>;
      const waiter={start:()=>{clearTimeout(timer);if(Date.now()>=expiresAt){reject(unavailable());this.leave();}else resolve();},cancel:()=>{const index=this.waiters.indexOf(waiter);if(index>=0)this.waiters.splice(index,1);reject(unavailable());}};
      timer=setTimeout(waiter.cancel,Math.max(1,expiresAt-Date.now()));this.waiters.push(waiter);
    });
  }
  leave(){const next=this.waiters.shift();if(next)next.start();else this.working=false;}
}
const gate=new PasswordComputationGate();
export class PasswordComputation {
  private env:PasswordEnvironment;
  private seen=new Map<string,number>();
  // Never retain state.storage, write storage, install alarms, or log DTOs.
  constructor(_state:unknown,env:PasswordEnvironment){this.env=env;}
  async fetch(request:Request):Promise<Response>{
    const headers={'content-type':'application/json','cache-control':'no-store'};
    if(this.env.PASSWORD_COMPUTATION_MODE!=='durable')return internalFailure(503,'mode');
    if(request.method!=='POST'||request.url!=='https://password.internal/compute'||request.headers.get('content-type')!=='application/json')return internalFailure(404,'route');
    let acquired=false;let phase:InternalReason='body';
    try{
      const signature=request.headers.get('x-ll-password-auth');if(!signature||!/^[A-Za-z0-9_-]{43}$/.test(signature))return internalFailure(403,'signature');
      const body=await boundedText(request,maxEnvelopeBytes);
      phase='authorization';if(!await crypto.subtle.verify('HMAC',await authorizationKey(this.env),Uint8Array.from(decode(signature)).buffer,await signedBytes(body)))return internalFailure(403,'signature');
      phase='envelope';const input:unknown=JSON.parse(body),now=Date.now();
      if(!object(input)||!exact(input,['version','installationId','requestId','issuedAt','expiresAt','operation','purpose','password',...(input.operation==='verify'?['encoded']:[])])||input.version!==2||input.installationId!=='primary'||typeof input.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(input.requestId)||!Number.isSafeInteger(input.issuedAt)||!Number.isSafeInteger(input.expiresAt)||!Number.isSafeInteger(input.expiresAt+clockSkewMs)||input.expiresAt-input.issuedAt!==deadlineMs||!validInput(input))return internalFailure(400,'envelope');
      if(input.issuedAt>now+clockSkewMs||input.expiresAt<=now-clockSkewMs)return internalFailure(400,'envelope-time');
      const replayUntil=input.expiresAt+clockSkewMs,localDeadline=Math.min(now+deadlineMs,replayUntil);
      for(const [id,expiry] of this.seen)if(expiry<=now)this.seen.delete(id);
      if(this.seen.has(input.requestId)||this.seen.size>=128)return internalFailure(409,'replay-capacity');this.seen.set(input.requestId,replayUntil);
      phase='gate';await gate.enter(localDeadline);acquired=true;
      phase='computation';const value=input.operation==='hash'?await hashPassword(input.password):await inlineVerify(input.password,input.encoded);
      if(Date.now()>=localDeadline)return internalFailure(503,'expired-result');
      return Response.json({version:2,requestId:input.requestId,operation:input.operation,value},{headers});
    }catch{return internalFailure(503,phase);}finally{if(acquired)gate.leave();}
  }
}
