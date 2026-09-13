// Shares the provisioned transport key, but separates assertion purpose, path and header.
export const UPLOAD_ASSERTION_HEADER='x-lancerlogin-upload-assertion';
const encoder=new TextEncoder();
export class UploadProxyError extends Error {readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
const buffer=(bytes:Uint8Array)=>Uint8Array.from(bytes).buffer;
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
function decode(text:string){if(!/^[A-Za-z0-9_-]+$/.test(text))throw Error('Invalid encoding');const value=Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));if(encode(value)!==text)throw Error('Noncanonical encoding');return value;}
async function key(text:string){const bytes=decode(text);if(bytes.length!==32)throw Error('Invalid key');return crypto.subtle.importKey('raw',buffer(bytes),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
const sign=async(secret:string,value:unknown)=>new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(JSON.stringify(value))));
export const uploadBodyHash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
function origin(text:string){const url=new URL(text);if(url.protocol!=='https:'||url.origin!==text)throw Error('Invalid origin');return text;}
export async function deriveUploadProxyKey(sessionKey:string,installation:string,pagesOrigin:string,apiOrigin:string){return encode(await sign(sessionKey,['lancerlogin-hours-proxy-key',1,installation,origin(pagesOrigin),origin(apiOrigin)]));}
export function canonicalUploadSource(value:string|null):string|null{
 if(!value||value.length>45||!value.includes(':')&&!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))return null;
 if(!value.includes(':')){const parts=value.split('.').map(Number);return parts.every(n=>n<=255)?parts.join('.'):null;}
 if(!/^[0-9a-fA-F:.]+$/.test(value))return null;
 try{const address=new URL('https://['+value+']/').hostname.slice(1,-1),mapped=/^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(address);
  if(address==='2a06:98c0:3600::103')return null;
  if(mapped){const high=parseInt(mapped[1],16),low=parseInt(mapped[2],16);return [high>>>8,high&255,low>>>8,low&255].join('.');}
  return address;
 }catch{return null;}
}
export function trustedPagesSource(request:Request):string|null{
 const cf=(request as Request&{cf?:unknown}).cf;
 if(!cf||typeof cf!=='object'||Array.isArray(cf)||request.headers.has('cf-worker'))return null;
 return canonicalUploadSource(request.headers.get('cf-connecting-ip'));
}
function path(request:Request){const url=new URL(request.url);if(!url.pathname.startsWith('/public/documentation/uploads')||url.pathname.length+url.search.length>8192)throw Error('Invalid public path');return url.pathname+url.search;}
export async function createUploadAssertion(request:Request,proxyKey:string,pagesOrigin:string,apiOrigin:string,source:string,body:Uint8Array,now=Date.now()){
 if(!Number.isSafeInteger(now)||now<0||body.byteLength>262144||!['GET','POST','PUT'].includes(request.method)||canonicalUploadSource(source)!==source||new URL(request.url).origin!==apiOrigin)throw Error('Invalid assertion input');
 const subject=encode(await sign(proxyKey,['lancerlogin-upload-source',1,Math.floor(now/862621440),source]));
 const value=[1,now,request.method,await uploadBodyHash(encoder.encode(path(request))),await uploadBodyHash(body),subject,origin(pagesOrigin),origin(apiOrigin)];
 const payload=encode(encoder.encode(JSON.stringify(value)));return payload+'.'+encode(await sign(proxyKey,['lancerlogin-upload-assertion',payload]));
}
export async function verifyUploadAssertion(request:Request,sessionKey:string,installation:string,pagesOrigin:string,body:Uint8Array,now=Date.now()):Promise<string|null>{
 try{
  const header=request.headers.get(UPLOAD_ASSERTION_HEADER);if(!header||header.length>1024||body.byteLength>262144||!Number.isSafeInteger(now)||now<0)return null;
  const parts=header.split('.');if(parts.length!==2)return null;const [payload,signature]=parts,apiOrigin=new URL(request.url).origin;
  const derived=await deriveUploadProxyKey(sessionKey,installation,pagesOrigin,apiOrigin);
  if(!await crypto.subtle.verify('HMAC',await key(derived),buffer(decode(signature)),encoder.encode(JSON.stringify(['lancerlogin-upload-assertion',payload]))))return null;
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(payload)));
  if(!Array.isArray(value)||value.length!==8||value[0]!==1||!Number.isSafeInteger(value[1])||value[1]>now+5000||value[1]<now-30000||Math.floor(value[1]/862621440)!==Math.floor(now/862621440)||value[2]!==request.method||value[3]!==await uploadBodyHash(encoder.encode(path(request)))||value[4]!==await uploadBodyHash(body)||typeof value[5]!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value[5])||value[6]!==pagesOrigin||value[7]!==apiOrigin)return null;
  return value[5];
 }catch{return null;}
}
export async function readUploadProxyBody(request:Request,deadlineMs=10000):Promise<Uint8Array>{
 if(request.method==='GET'){if(request.body)throw new UploadProxyError(400,'Public catalog requests cannot contain a body');return new Uint8Array();}
 if(!['POST','PUT'].includes(request.method))throw new UploadProxyError(405,'Unsupported Upload operation');
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!==(request.method==='PUT'?'application/octet-stream':'application/json'))throw new UploadProxyError(415,'Content-Type must be application/json');
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144)){void request.body?.cancel().catch(()=>undefined);throw new UploadProxyError(413,'Request body is too large');}
 if(!request.body)throw new UploadProxyError(400,'Provide a JSON object');
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>10000)throw new UploadProxyError(503,'Invalid request read deadline');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new UploadProxyError(408,'Request body took too long; retry explicitly')),deadlineMs);});
 try{for(;;){const result=await Promise.race([reader.read(),deadline]);if(result.done)break;bytes+=result.value.byteLength;if(bytes>262144)throw new UploadProxyError(413,'Request body is too large');chunks.push(result.value);}}
 catch(error){void reader.cancel().catch(()=>undefined);if(error instanceof UploadProxyError)throw error;throw new UploadProxyError(400,'Unable to read request body');}finally{clearTimeout(timer);reader.releaseLock();}
 const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}return body;
}
