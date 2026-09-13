import type {Env} from './index.ts';
import {HttpError} from './http-error.ts';
export type DocumentComputeBinding={fetch(request:Request):Promise<Response>};
const origin='https://lancerlogin-v2-example-dashboard.pages.dev';
const cases=['png-v1','jpeg-v1','modern-pdf-v1','mixed-v1','recovery-v1','cpu-fault-v1','memory-fault-v1'];
const unavailable=():never=>{throw new HttpError(503,'Document compute proof unavailable; read its existing state before any new action.');};
async function bytes(body:ReadableStream<Uint8Array>|null,max:number){if(!body)return new Uint8Array();const reader=body.getReader(),parts:Uint8Array[]=[];let size=0;
 let timer:ReturnType<typeof setTimeout>|undefined;const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(503,'Document compute response deadline')),5000);});
 try{for(;;){const {value,done}=await Promise.race([reader.read(),deadline]);if(done)break;size+=value.length;if(size>max)unavailable();parts.push(value);}}catch(e){void reader.cancel().catch(()=>{});throw e;}finally{clearTimeout(timer);reader.releaseLock();}
 const out=new Uint8Array(size);let pos=0;for(const p of parts){out.set(p,pos);pos+=p.length;}return out;}
export async function documentComputeProof(request:Request,env:Env,actor:{userId:string;expiresAt:number}){
 if(env.ALLOWED_ORIGIN!==origin||env.DOCUMENT_COMPUTE_PROOF_MODE!=='synthetic'||!env.DOCUMENT_COMPUTE)throw new HttpError(404,'Not found');
 const u=new URL(request.url),m=/^\/admin\/document-compute\/proofs\/([a-z0-9-]+)(\/result)?$/.exec(u.pathname);
 if(u.search||!m||!cases.includes(m[1])||!['POST','GET'].includes(request.method)||m[2]&&request.method!=='GET')throw new HttpError(404,'Not found');
 const current=async()=>{if(actor.expiresAt<=Date.now())throw new HttpError(403,'Admin access required');const found=await env.DB!.prepare("SELECT id FROM users WHERE installation_id='primary' AND id=? AND active=1 AND role='admin'").bind(actor.userId).first();if(!found)throw new HttpError(403,'Admin access required');};
 let body:string|undefined;
 if(request.method==='POST'){if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new HttpError(415,'JSON required');let input;try{input=JSON.parse(new TextDecoder().decode(await bytes(request.body,256)));}catch{throw new HttpError(400,'Invalid proof confirmation');}
  if(!input||Object.keys(input).join(',')!=='confirmation'||input.confirmation!=='RUN FIXED SYNTHETIC DOCUMENT COMPUTE')throw new HttpError(400,'Invalid proof confirmation');body=JSON.stringify(input);}
 await current();const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 let response:Response;try{response=await Promise.race([env.DOCUMENT_COMPUTE.fetch(new Request('https://document.internal/proofs/'+m[1]+(m[2]??''),{method:request.method,headers:body?{'content-type':'application/json'}:{},body,signal:controller.signal})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new HttpError(503,'Document compute request deadline'));},5000);})]);}catch{return unavailable();}finally{clearTimeout(timer);}
 if(!response.ok){void response.body?.cancel().catch(()=>{});return unavailable();}
 if(m[2]){const n=response.headers.get('content-length'),digest=response.headers.get('x-document-sha256'),manifest=response.headers.get('x-document-manifest-sha256');
  if(response.headers.get('content-type')!=='application/pdf'||!n||!/^\d+$/.test(n)||Number(n)<1||Number(n)>16777216||!/^[a-f0-9]{64}$/.test(digest??'')||!/^[a-f0-9]{64}$/.test(manifest??''))return unavailable();
  const result=await bytes(response.body,Number(n));if(result.length!==Number(n))return unavailable();const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',result)),v=>v.toString(16).padStart(2,'0')).join('');if(actual!==digest)return unavailable();await current();
  return new Response(result,{headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="synthetic-document-proof.pdf"','cache-control':'no-store','x-document-sha256':digest!}});
 }
 let state;try{state=JSON.parse(new TextDecoder().decode(await bytes(response.body,8192)));}catch{return unavailable();}
 if(!state||state.id!=='proof-'+m[1]||!['queued','running','complete','failed','expired'].includes(state.state)||![0,1].includes(state.attempts))return unavailable();
 const safe:Record<string,unknown>={id:state.id,state:state.state,attempts:state.attempts};
 for(const k of ['createdAt','expiresAt','startedAt','finishedAt','byteLength','pageCount'])if(state[k]!==undefined){if(!Number.isSafeInteger(state[k])||state[k]<0)return unavailable();safe[k]=state[k];}
 for(const k of ['sha256','manifestDigest'])if(state[k]!==undefined){if(!/^[a-f0-9]{64}$/.test(state[k]))return unavailable();safe[k]=state[k];}
 if(state.error!==undefined){if(!['EXECUTION_INTERRUPTED','COMPUTATION_FAILED','FAULT_BOUNDARY_INCONCLUSIVE','INPUT_REJECTED'].includes(state.error))return unavailable();safe.error=state.error;}
 await current();return Response.json(safe,{status:response.status,headers:{'cache-control':'no-store'}});
}
