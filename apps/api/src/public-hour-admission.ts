import { readHoursProxyBody, HoursProxyError } from '@lancerlogin/shared/hours-proxy';
import { HttpError } from './http-error.ts';
import type { ModuleDatabase } from './platform-modules.ts';

export class PublicHourAdmissionError extends HttpError {
 readonly retryAfter:number;
 constructor(status:429|503,retryAfter=60){super(status,status===429?'Too many requests; wait before trying again':'Public submission admission is unavailable');this.retryAfter=retryAfter;}
}
const encoder=new TextEncoder();
async function subjectHash(secret:string,installation:string,epoch:number,subject:string){
 let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(secret.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}catch{throw new PublicHourAdmissionError(503);}
 if(bytes.length<32)throw new PublicHourAdmissionError(503);
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(bytes).buffer,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('HMAC',key,encoder.encode(JSON.stringify(['public-hours-admission-v1',installation,epoch,subject])));
 return Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,'0')).join('');
}

/** Trusted adapter input only: a source token must come from verified Pages assertions.
 * Unknown ingress shares one restrictive bucket, rather than accepting spoofable IPs.
 */
export async function admitPublicHours(db:ModuleDatabase,installation:string,secret:string,kind:'read'|'mutation',now:number,verifiedSource:string|null=null){
 try{return await reserve(db,installation,secret,kind,now,verifiedSource);}catch(error){if(error instanceof PublicHourAdmissionError)throw error;throw new PublicHourAdmissionError(503);}
}
async function reserve(db:ModuleDatabase,installation:string,secret:string,kind:'read'|'mutation',now:number,verifiedSource:string|null=null){
 if(!Number.isSafeInteger(now)||now<0)throw new PublicHourAdmissionError(503);
 const policy=kind+'-v1',day=Math.floor(now/86400000);
 const source=await subjectHash(secret,installation,day,verifiedSource&&/^[A-Za-z0-9_-]{43}$/.test(verifiedSource)?'verified:'+verifiedSource:'unverified-ingress'),global=await subjectHash(secret,installation,day,'installation');
 const buckets=kind==='mutation'?[['source-minute',source,60000,30],['source-hour',source,3600000,300],['installation-minute',global,60000,300],['installation-day',global,86400000,5000]] as const:[['source-minute',source,60000,120],['source-hour',source,3600000,1200],['installation-minute',global,60000,1200],['installation-day',global,86400000,20000]] as const;
 const statements=[db.prepare('INSERT INTO public_hour_admission_clock(installation_id,last_seen_ms) VALUES(?,?) ON CONFLICT(installation_id) DO UPDATE SET last_seen_ms=MAX(public_hour_admission_clock.last_seen_ms,excluded.last_seen_ms) WHERE public_hour_admission_clock.last_seen_ms<=excluded.last_seen_ms+5000').bind(installation,now)];
 for(const [scope,subject,duration,capacity] of buckets){const start=Math.floor(now/duration)*duration;statements.push(db.prepare(`INSERT INTO public_hour_admission(installation_id,policy,scope,subject_hash,window_start,expires_at,attempts,capacity) SELECT ?,?,?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM public_hour_admission_clock WHERE installation_id=? AND last_seen_ms BETWEEN ? AND ?+5000) ON CONFLICT(installation_id,policy,scope,subject_hash,window_start) DO UPDATE SET attempts=public_hour_admission.attempts+1`).bind(installation,policy,scope,subject,start,start+duration,capacity,installation,now,now));}
 statements.push(db.prepare('DELETE FROM public_hour_admission WHERE rowid IN (SELECT rowid FROM public_hour_admission WHERE installation_id=? AND expires_at<=? ORDER BY expires_at LIMIT 64)').bind(installation,now-5000));
 try{const result=await db.batch(statements);if(result[0]?.meta?.changes!==1||result.slice(1,5).some(r=>r.meta?.changes!==1))throw new PublicHourAdmissionError(503);}
 catch(error){if(error instanceof PublicHourAdmissionError)throw error;if(String(error).includes('public_hour_admission_capacity')){let retry: {retryAt:number}|null;try{retry=await db.prepare('SELECT MAX(expires_at) AS retryAt FROM public_hour_admission WHERE installation_id=? AND policy=? AND expires_at>? AND attempts>=capacity AND subject_hash IN (?,?)').bind(installation,policy,now,source,global).first<{retryAt:number}>();}catch{throw new PublicHourAdmissionError(503);}if(!retry||!Number.isSafeInteger(retry.retryAt)||retry.retryAt<=now)throw new PublicHourAdmissionError(503);throw new PublicHourAdmissionError(429,Math.min(86400,Math.max(1,Math.ceil((retry.retryAt-now)/1000))));}throw new PublicHourAdmissionError(503);}
}

export function decodePublicHourJson(body:Uint8Array):unknown{
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new HttpError(400,'Request body must be valid JSON');}
}
export async function readPublicHourJson(request:Request,deadlineMs=10000):Promise<unknown>{
 try{return decodePublicHourJson(await readHoursProxyBody(request,deadlineMs));}catch(error){if(error instanceof HoursProxyError)throw new HttpError(error.status,error.message);throw error;}
}
