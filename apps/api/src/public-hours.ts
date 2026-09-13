import { readHoursProxyBody, verifyHoursAssertion, HoursProxyError } from '@lancerlogin/shared/hours-proxy';
import { addCalendarDays, instantToCivil } from '@lancerlogin/shared/civil-time';
import { HttpError } from './http-error.ts';
import { submitSelfAssertedHours } from './hour-accounting.ts';
import { requestSelfAssertedHourCorrection } from './hour-review-reports.ts';
import { admitPublicHours, PublicHourAdmissionError, decodePublicHourJson } from './public-hour-admission.ts';
import type { ModuleDatabase } from './platform-modules.ts';
type Row=Record<string,any>;
type PublicEnv={DB?:ModuleDatabase;SESSION_KEY?:string;ALLOWED_ORIGIN?:string};
const headers={'cache-control':'no-store','content-type':'application/json; charset=utf-8'};
const reply=(body:unknown,status=200,extra:Record<string,string>={})=>Response.json(body,{status,headers:{...headers,...extra}});
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
function text(v:unknown,max=128,empty=false){if(typeof v!=='string'||v.length>max||(!empty&&!v.trim()))throw new HttpError(400,'Invalid public hour field');return v.trim();}
function params(url:URL,allowed:string[]){url.searchParams.forEach((_,k)=>{if(!allowed.includes(k)||url.searchParams.getAll(k).length!==1)throw new HttpError(400,'Invalid catalog filter');});}
const available=`EXISTS(SELECT 1 FROM platform_module_configuration WHERE installation_id=? AND hours_enabled=1)`;
async function clockContext(db:ModuleDatabase,installation:string,now:number){
 const row=await db.prepare(`SELECT o.time_zone AS timeZone,s.reporting_days AS reportingDays FROM organization_settings o JOIN hours_entry_settings s ON s.installation_id=o.installation_id WHERE o.installation_id=? AND ${available}`).bind(installation,installation).first<Row>();
 if(!row)return null;let today:string,earliestServiceDate:string;
 try{today=instantToCivil(now,row.timeZone).date;if(!Number.isSafeInteger(row.reportingDays)||row.reportingDays<1||row.reportingDays>365)throw Error();try{earliestServiceDate=addCalendarDays(today,1-row.reportingDays);}catch{earliestServiceDate='0000-01-01';}}
 catch{throw new HttpError(503,'Hour Tracking is unavailable');}
 return {timeZone:row.timeZone,today,earliestServiceDate,reportingDays:row.reportingDays};
}

/** Anonymous browser adapter only. It never promotes cookies or JSON flags to staff authority. */
export async function publicHours(request:Request,env:PublicEnv,installation='primary',clock:()=>number=Date.now):Promise<Response>{
 try{
  const now=clock(),url=new URL(request.url),kind=url.pathname.slice('/public/hours/'.length);
  const read=['context','categories','events','teams'].includes(kind),write=['entries','correction-requests'].includes(kind);
  if(!read&&!write)return reply({error:'Public hour route not found'},404);
  if(request.method!==(read?'GET':'POST'))return reply({error:'Unsupported public hour operation'},405);
  if(write&&(!env.ALLOWED_ORIGIN||request.headers.get('origin')!==env.ALLOWED_ORIGIN))return reply({error:'Public submissions require the configured form origin'},403);
  if(!env.DB||!env.SESSION_KEY)throw new HttpError(503,'Hour Tracking is unavailable');const db=env.DB;
  const context=await clockContext(db,installation,now);
  if(!context)return kind==='context'?reply({available:false}):reply({error:'Hour Tracking is unavailable'},403);
  let body:Uint8Array;
  try{body=await readHoursProxyBody(request);}catch(error){
   await admitPublicHours(db,installation,env.SESSION_KEY,read?'read':'mutation',clock());
   if(error instanceof HoursProxyError)throw new HttpError(error.status,error.message);throw error;
  }
  const admissionNow=clock();
  const source=env.ALLOWED_ORIGIN?await verifyHoursAssertion(request,env.SESSION_KEY,installation,env.ALLOWED_ORIGIN,body,admissionNow):null;
  await admitPublicHours(db,installation,env.SESSION_KEY,read?'read':'mutation',admissionNow,source);
  if(write){
   params(url,[]);const input=decodePublicHourJson(body);
   if(kind==='entries'){
    if(!object(input))throw new HttpError(400,'Provide an hour object');text(input.expectedTimeZone,100);text(input.serviceDate,10);
    try{return reply(await submitSelfAssertedHours(db,installation,input,clock()),201);}
    catch(error){if(error instanceof HttpError&&[400,409].includes(error.status))return reply({error:'Unable to record these hours. Check your details or request a correction.',code:'submission_not_accepted',correctionAvailable:true},409);throw error;}
   }
   return reply(await requestSelfAssertedHourCorrection(db,installation,input,clock()),202);
  }
  if(kind==='context'){params(url,[]);const current=await clockContext(db,installation,now);return reply(current?{available:true,...current}:{available:false});}
  params(url,kind==='events'?['categoryId','date','after','limit']:kind==='teams'?['q','after','limit']:['after','limit']);
  const limit=Number(url.searchParams.get('limit')??50);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new HttpError(400,'Invalid catalog limit');
  const after=text(url.searchParams.get('after')??'',128,true);let rows:Row[];
  if(kind==='categories')rows=(await db.prepare(`SELECT id,name,mode FROM hours_categories WHERE installation_id=? AND archived=0 AND id>? AND ${available} ORDER BY id LIMIT ?`).bind(installation,after,installation,limit+1).all<Row>()).results??[];
  else if(kind==='teams'){
   const q=text(url.searchParams.get('q')??'',100,true);
   rows=(await db.prepare(`SELECT id,name,number,program FROM hours_teams WHERE installation_id=? AND archived=0 AND id>? AND (?='' OR instr(lower(name||' '||number||' '||program),lower(?))>0) AND ${available} ORDER BY id LIMIT ?`).bind(installation,after,q,q,installation,limit+1).all<Row>()).results??[];
  }else{
   const category=url.searchParams.has('categoryId')?text(url.searchParams.get('categoryId')):null,day=url.searchParams.get('date');
   if(day!==null){try{addCalendarDays(day,0);}catch{throw new HttpError(400,'Invalid catalog date');}}
   rows=(await db.prepare(`SELECT a.id,a.category_id AS categoryId,a.title,a.service_date AS serviceDate FROM hours_activities a JOIN hours_categories c ON c.installation_id=a.installation_id AND c.id=a.category_id WHERE a.installation_id=? AND a.mode='event' AND a.archived=0 AND c.archived=0 AND a.id>? AND (? IS NULL OR a.category_id=?) AND (? IS NULL OR a.service_date=?) AND a.service_date<=? AND (a.service_date>=? OR EXISTS(SELECT 1 FROM hours_reopen_windows w WHERE w.installation_id=a.installation_id AND w.revoked=0 AND w.starts_ms<=? AND w.expires_ms>? AND (w.activity_id IS NULL OR w.activity_id=a.id))) AND ${available} AND EXISTS(SELECT 1 FROM organization_settings o JOIN hours_entry_settings s ON s.installation_id=o.installation_id WHERE o.installation_id=? AND o.time_zone=? AND s.reporting_days=?) ORDER BY a.id LIMIT ?`).bind(installation,after,category,category,day,day,context.today,context.earliestServiceDate,now,now,installation,installation,context.timeZone,context.reportingDays,limit+1).all<Row>()).results??[];
  }
  const current=await clockContext(db,installation,now);if(!current)throw new HttpError(403,'Hour Tracking is unavailable');
  if(current.timeZone!==context.timeZone||current.reportingDays!==context.reportingDays)throw new HttpError(409,'The submission context changed; refresh the form');
  return reply({items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null});
 }catch(error){
  if(error instanceof PublicHourAdmissionError)return reply({error:error.message},error.status,{'retry-after':String(error.retryAfter)});
  if(error instanceof HttpError)return reply({error:error.message},error.status);
  return reply({error:'Hour Tracking is temporarily unavailable'},503);
 }
}
