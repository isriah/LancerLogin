import { addCalendarDays, selectCivilTime, elapsedIntegerMinutes, instantToCivil, CivilTimeError } from '@lancerlogin/shared/civil-time';
import { HttpError } from './http-error.ts';
import { requireModuleCapability, type ModuleDatabase } from './platform-modules.ts';
type Row = Record<string, any>;
type Context = { channel:'staff'|'public'|'discord'; actor:string|null; discordUserId?:string;discordProviderIv?:string };
export const accountingColumns = {
 hours_entry_settings:['installation_id','reporting_days','reopen_hours','revision'],
 hours_reopen_windows:['installation_id','id','activity_id','starts_ms','expires_ms','revoked','revision','actor_user_id','created_at'],
 hours_entries:['installation_id','id','activity_id','member_id','service_date','time_zone','start_local','end_local','end_next_day','start_occurrence','end_occurrence','start_ms','end_ms','start_offset_seconds','end_offset_seconds','duration_minutes','task_notes','status','channel','attribution','actor_user_id','revision','created_at','updated_at'],
 hours_entry_revisions:['installation_id','entry_id','revision','member_id','activity_id','action','reason','actor_user_id','snapshot','created_at'],
 hours_submission_keys:['installation_id','channel','key_hash','fingerprint','entry_id','receipt','created_at'],
} as const;
const staffFence=`EXISTS(SELECT 1 FROM users u JOIN platform_module_configuration c ON c.installation_id=u.installation_id LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id=? AND u.id=? AND u.active=1 AND c.hours_enabled=1 AND (u.role='admin' OR g.hours_manage=1))`;
const moduleFence=`EXISTS(SELECT 1 FROM platform_module_configuration WHERE installation_id=? AND hours_enabled=1)`;
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const string=(v:unknown,max=128,required=true)=>{if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw new HttpError(400,'Invalid or missing hour field');return v.trim();};
const number=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER-1)=>{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw new HttpError(400,'Invalid hour setting or revision');return Number(v);};
const date=(v:unknown)=>addCalendarDays(string(v,10),0);
const bool=(v:unknown)=>{if(typeof v!=='boolean')throw new HttpError(400,'Provide an explicit next-day flag');return Number(v);};
const unknownFields=(v:Row,allowed:string[])=>{if(Object.keys(v).some(k=>!allowed.includes(k)))throw new HttpError(400,'Unknown hour field');};
const sha=async(v:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const canonical=(v:Row)=>JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])));
const jsonSql=(columns:readonly string[])=>`json_object(${columns.flatMap(c=>[`'${c}'`,c]).join(',')})`;
const timingColumns=['service_date','time_zone','start_local','end_local','end_next_day','start_occurrence','end_occurrence','start_ms','end_ms','start_offset_seconds','end_offset_seconds','duration_minutes'];
const receiptColumns=['id','activity_id','service_date','time_zone','start_local','end_local','end_next_day','start_occurrence','end_occurrence','start_ms','end_ms','start_offset_seconds','end_offset_seconds','duration_minutes','task_notes','created_at'];
const receiptSQL=jsonSql(receiptColumns);
function staffRow(row:Row){return Object.fromEntries(Object.entries(row).filter(([k])=>k!=='installation_id').map(([k,v])=>[k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),['end_next_day','revoked'].includes(k)?Boolean(v):v]));}
async function authorize(db:ModuleDatabase,installation:string,context:Context){if(context.channel==='staff')await requireModuleCapability(db,installation,context.actor!,'hours.manage');else if(!await db.prepare(`SELECT 1 FROM platform_module_configuration WHERE installation_id=? AND hours_enabled=1`).bind(installation).first())throw new HttpError(403,'Hour Tracking is unavailable');}
function authFence(installation:string,context:Context):[string,unknown[]]{return context.channel==='staff'?[staffFence,[installation,context.actor]]:[moduleFence,[installation]];}
function clock(now:number){if(!Number.isSafeInteger(now)||!Number.isFinite(new Date(now).getTime()))throw new HttpError(400,'Invalid current instant');return new Date(now).toISOString();}
function timing(input:Row,serviceDate:string,zone:string,now:number){
 const startLocal=string(input.startLocal,12),endLocal=string(input.endLocal,12),endNextDay=bool(input.endNextDay);
 const start=selectCivilTime({date:serviceDate,time:startLocal,timeZone:zone},input.startOccurrence??undefined);
 const end=selectCivilTime({date:addCalendarDays(serviceDate,endNextDay),time:endLocal,timeZone:zone},input.endOccurrence??undefined);
 const minutes=elapsedIntegerMinutes(start.epochMilliseconds,end.epochMilliseconds);
 if(end.epochMilliseconds>now)throw new HttpError(400,'Completed hours cannot end in the future');
 return {service_date:serviceDate,time_zone:zone,start_local:startLocal,end_local:endLocal,end_next_day:endNextDay,start_occurrence:input.startOccurrence??null,end_occurrence:input.endOccurrence??null,start_ms:start.epochMilliseconds,end_ms:end.epochMilliseconds,start_offset_seconds:start.offsetSeconds,end_offset_seconds:end.offsetSeconds,duration_minutes:minutes};
}
async function run<T>(fn:()=>Promise<T>):Promise<T>{try{return await fn();}catch(error){if(error instanceof CivilTimeError)throw new HttpError(400,error.message);throw error;}}
async function savedReceipt(db:ModuleDatabase,installation:string,channel:string,key:string,fingerprint:string){const row=await db.prepare('SELECT fingerprint,receipt FROM hours_submission_keys WHERE installation_id=? AND channel=? AND key_hash=?').bind(installation,channel,key).first<Row>();if(!row)return null;if(row.fingerprint!==fingerprint)throw new HttpError(409,'Submission key was already used for different input');return JSON.parse(row.receipt);}

/** Server-only entry points. Channel/attribution never come from request JSON.
 * The future Discord adapter must authenticate the signed guild/user before calling;
 * this service additionally resolves and fences the current roster pairing.
 */
export const submitStaffHours=(db:ModuleDatabase,installation:string,actor:string,input:unknown,now=Date.now())=>run(()=>save(db,installation,{channel:'staff',actor},input,now));
export const submitSelfAssertedHours=(db:ModuleDatabase,installation:string,input:unknown,now=Date.now())=>run(()=>save(db,installation,{channel:'public',actor:null},input,now));
export const submitLinkedDiscordHours=(db:ModuleDatabase,installation:string,discordUserId:string,input:unknown,now=Date.now(),discordProviderIv?:string)=>run(()=>save(db,installation,{channel:'discord',actor:null,discordUserId:string(discordUserId,24),discordProviderIv},input,now));
export type HourReviewLink={requestId:string;requestRevision:number;note:string};
/** Internal review service only: metadata is supplied after staff resolution validation. */
export const applyReviewedHourChange=(db:ModuleDatabase,installation:string,actor:string,input:unknown,edit:{id:string;void:boolean},review:HourReviewLink,now=Date.now())=>run(()=>save(db,installation,{channel:'staff',actor},input,now,edit,review));
async function save(db:ModuleDatabase,installation:string,context:Context,input:unknown,now:number,edit?:{id:string;void:boolean},review?:HourReviewLink) {
 await authorize(db,installation,context);const nowText=clock(now);
 if(!obj(input))throw new HttpError(400,'Provide an hour object');
 const fields=['memberId','activityId','categoryId','teamId','serviceDate','startLocal','endLocal','endNextDay','startOccurrence','endOccurrence','taskNotes'];
 unknownFields(input,edit?(edit.void?['revision','reason']:[...fields,'revision','reason']):context.channel==='discord'?[...fields.filter(f=>f!=='memberId'),'idempotencyKey','expectedTimeZone']:[...fields,'idempotencyKey','expectedTimeZone']);
 const key=edit?null:await sha(string(input.idempotencyKey,128));
 if(!edit&&string(input.idempotencyKey,128).length<16)throw new HttpError(400,'Use a submission key of 16–128 characters');
 const fingerprint=edit?'':await sha(canonical({...input,channel:context.channel,actor:context.actor,discordUserId:context.discordUserId??null}));
 if(key){const receipt=await savedReceipt(db,installation,context.channel,key,fingerprint);if(receipt)return receipt;}
 const existing=edit?await db.prepare('SELECT * FROM hours_entries WHERE installation_id=? AND id=?').bind(installation,edit.id).first<Row>():null;
 if(existing&&now<Date.parse(existing.updated_at))throw new HttpError(409,'Server clock precedes the saved entry; retry after clock recovery');
 if(edit&&(!existing||existing.status!=='counted'))throw new HttpError(409,'Counted entry is unavailable; reload');
 const expected=edit?number(input.revision):0,reason=edit?string(input.reason,4000):'';
 const merged=existing?{...staffRow(existing),...input}:input;
 const settings=await db.prepare('SELECT reporting_days,reopen_hours,revision FROM hours_entry_settings WHERE installation_id=?').bind(installation).first<Row>();
 if(!settings)throw new HttpError(503,'Hour settings are unavailable');
 const installationZone=(await db.prepare('SELECT time_zone FROM organization_settings WHERE installation_id=?').bind(installation).first<Row>())?.time_zone;
 if(!existing&&input.expectedTimeZone!==undefined&&string(input.expectedTimeZone,100)!==installationZone)throw new HttpError(409,'The entry time zone changed; reload the clock context before submitting');
 const zone=existing?.time_zone??installationZone;
 const today=instantToCivil(now,installationZone).date;
 let earliest:string;try{earliest=addCalendarDays(today,1-settings.reporting_days);}catch{earliest='0000-01-01';}
 let member:Row|null;
 if(context.channel==='discord')member=await db.prepare('SELECT id,active FROM members WHERE installation_id=? AND discord_user_id=?').bind(installation,context.discordUserId).first<Row>();
 else member=await db.prepare(`SELECT id,active FROM members WHERE installation_id=? AND ${context.channel==='staff'?'id':'external_id'}=?`).bind(installation,string(merged.memberId)).first<Row>();
 if(!member||(context.channel!=='staff'&&!member.active))throw new HttpError(400,'Member identity is unavailable');
 let activity=merged.activityId?await db.prepare('SELECT * FROM hours_activities WHERE installation_id=? AND id=?').bind(installation,string(merged.activityId)).first<Row>():null;
 if(merged.activityId&&!activity)throw new HttpError(400,'Activity is unavailable');
 // Changing activity explicitly discards the old derived category/date for validation.
 const categoryId=activity?.category_id??string(merged.categoryId),category=await db.prepare('SELECT * FROM hours_categories WHERE installation_id=? AND id=?').bind(installation,categoryId).first<Row>();
 if(!category)throw new HttpError(400,'Category is unavailable');
 if(!activity&&category.mode==='event')throw new HttpError(400,'Select an existing event');
 const serviceDate=edit?.void?existing!.service_date:activity?.service_date??date(merged.serviceDate),teamId=activity?.team_id??(category.mode==='team'?string(merged.teamId):null);
 if(activity&&('serviceDate'in input&&input.serviceDate!==serviceDate))throw new HttpError(400,'Use the activity service date');
 if(('categoryId'in input&&input.categoryId!==categoryId)||('teamId'in input&&input.teamId!==teamId))throw new HttpError(400,'Activity identity does not match');
 if(!activity&&category.mode!=='team'&&merged.teamId!=null)throw new HttpError(400,'This category does not take a supported team');
 const values:Row={...(edit?.void?Object.fromEntries(timingColumns.map(k=>[k,existing![k]])):timing(merged,serviceDate,zone,now)),member_id:member.id,task_notes:string(merged.taskNotes??'',4000,false),status:edit?.void?'void':'counted'};
 const id=edit?.id??crypto.randomUUID(),activityCandidate=activity?.id??crypto.randomUUID(),nextRevision=edit?expected+1:0;
 const [auth,authValues]=authFence(installation,context);
 let guard=`${auth} AND EXISTS(SELECT 1 FROM organization_settings WHERE installation_id=? AND time_zone=?) AND EXISTS(SELECT 1 FROM hours_entry_settings WHERE installation_id=? AND revision=?) AND EXISTS(SELECT 1 FROM members WHERE installation_id=? AND id=? ${context.channel==='staff'?'':'AND active=1'} ${context.channel==='discord'?'AND discord_user_id=?':''}) AND EXISTS(SELECT 1 FROM hours_categories WHERE installation_id=? AND id=? AND revision=? ${context.channel==='staff'&&activity?'':'AND archived=0'})`;
 const guardValues:unknown[]=[...authValues,installation,installationZone,installation,settings.revision,installation,member.id,...(context.channel==='discord'?[context.discordUserId]:[]),installation,categoryId,category.revision];
 if(context.discordProviderIv){guard+=` AND EXISTS(SELECT 1 FROM encrypted_integrations i JOIN installations x ON x.id=i.installation_id WHERE i.installation_id=? AND i.provider='discord' AND i.iv=? AND i.verified_at IS NOT NULL AND x.discord_enabled=1)`;guardValues.push(installation,context.discordProviderIv);}
 if(activity){guard+=` AND EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND id=? AND revision=? ${context.channel==='staff'?'':'AND archived=0'})`;guardValues.push(installation,activity.id,activity.revision);}
 if(teamId){guard+=` AND EXISTS(SELECT 1 FROM hours_teams WHERE installation_id=? AND id=? ${context.channel==='staff'&&activity?'':'AND archived=0'})`;guardValues.push(installation,teamId);}
 if(context.channel!=='staff'){
  guard+=` AND ?<=? AND (? >= ? OR (?='event' AND EXISTS(SELECT 1 FROM hours_reopen_windows WHERE installation_id=? AND revoked=0 AND starts_ms<=? AND expires_ms>? AND (activity_id IS NULL OR activity_id=?))))`;
  guardValues.push(serviceDate,today,serviceDate,earliest,category.mode,installation,now,now,activity?.id??null);
 }
 if(edit){guard+=" AND EXISTS(SELECT 1 FROM hours_entries WHERE installation_id=? AND id=? AND revision=? AND status='counted')";guardValues.push(installation,edit.id,expected);}
 if(review){guard+=" AND EXISTS(SELECT 1 FROM hours_correction_requests WHERE installation_id=? AND id=? AND revision=? AND status='open' AND created_at<=?)";guardValues.push(installation,review.requestId,review.requestRevision,nowText);}
 if(key){guard+=' AND NOT EXISTS(SELECT 1 FROM hours_submission_keys WHERE installation_id=? AND channel=? AND key_hash=?)';guardValues.push(installation,context.channel,key);}
 const statements=[];
 if(!activity)statements.push(db.prepare(`INSERT INTO hours_activities(installation_id,id,category_id,mode,service_date,team_id,title,planning_time_zone,impact_relevant,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`).bind(installation,activityCandidate,categoryId,category.mode,serviceDate,teamId,`${category.name} — ${serviceDate}`,zone,category.impact_default,nowText,nowText,...guardValues));
 const activitySQL=activity?'?':`(SELECT id FROM hours_activities WHERE installation_id=? AND category_id=? AND service_date=? AND team_id IS ? AND archived=0)`;
 const activityValues=activity?[activity.id]:[installation,categoryId,serviceDate,teamId];
 const valueKeys=Object.keys(values),valueData=Object.values(values);
 let entry;
 if(edit)entry=db.prepare(`UPDATE hours_entries SET ${valueKeys.map(k=>k+'=?').join(',')},activity_id=${activitySQL},revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=? AND status='counted' AND ${guard}`).bind(...valueData,...activityValues,nowText,installation,id,expected,...guardValues);
 else entry=db.prepare(`INSERT INTO hours_entries(installation_id,id,activity_id,${valueKeys.join(',')},channel,attribution,actor_user_id,revision,created_at,updated_at) SELECT ?,?,${activitySQL},${valueKeys.map(()=>'?').join(',')},?,?,?,0,?,? WHERE ${guard}`).bind(installation,id,...activityValues,...valueData,context.channel,{staff:'staff_recorded',public:'self_asserted',discord:'linked_discord'}[context.channel],context.actor,nowText,nowText,...guardValues);
 const entryIndex=statements.length;statements.push(entry);
 const auditId=crypto.randomUUID();
 statements.push(db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'hour_entry',?,?,? WHERE changes()=1`).bind(auditId,installation,context.actor,edit?(edit.void?'hours.entry.voided':'hours.entry.corrected'):'hours.entry.created',id,JSON.stringify({revision:nextRevision}),nowText));
 statements.push(db.prepare(`INSERT INTO hours_entry_revisions(installation_id,entry_id,revision,member_id,activity_id,action,reason,actor_user_id,snapshot,created_at) SELECT installation_id,id,revision,member_id,activity_id,?,?,?,${jsonSql(accountingColumns.hours_entries)},? FROM hours_entries WHERE installation_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(edit?(edit.void?'voided':'corrected'):'created',reason,context.actor,nowText,installation,id,auditId));
 if(key)statements.push(db.prepare(`INSERT INTO hours_submission_keys(installation_id,channel,key_hash,fingerprint,entry_id,receipt,created_at) SELECT installation_id,channel,?,?,id,${receiptSQL},? FROM hours_entries WHERE installation_id=? AND id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(key,fingerprint,nowText,installation,id,auditId));
 if(review){
  statements.push(db.prepare(`UPDATE hours_correction_requests SET status='resolved',revision=1,resolved_at=? WHERE installation_id=? AND id=? AND revision=? AND status='open' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(nowText,installation,review.requestId,review.requestRevision,auditId));
  statements.push(db.prepare(`INSERT INTO hours_correction_resolutions(installation_id,request_id,action,note,actor_user_id,entry_id,entry_revision,created_at) SELECT ?,?,?,?,?,?,?,? WHERE changes()=1`).bind(installation,review.requestId,edit!.void?'voided':'corrected',review.note,context.actor,id,nextRevision,nowText));
  statements.push(db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'hours.request.resolved','hour_correction_request',?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),installation,context.actor,review.requestId,JSON.stringify({action:edit!.void?'voided':'corrected',entryId:id,entryRevision:nextRevision}),nowText));
 }
 let results;
 try{results=await db.batch(statements);}catch(error){if(/hours_overlap/.test(String(error)))throw new HttpError(409,'This time overlaps counted hours. Request a correction instead.');if(/constraint|NOT NULL/i.test(String(error)))throw new HttpError(409,'Hour identity or references changed; reload before retrying');throw error;}
 if(key){const receipt=await savedReceipt(db,installation,context.channel,key,fingerprint);if(receipt)return receipt;}
 if(results[entryIndex]?.meta?.changes!==1)throw new HttpError(409,'Hour record, eligibility or access changed; reload before retrying');
 return {id,revision:nextRevision,status:values.status};
}

export function isAccountingPath(path:string){return /^\/admin\/hours\/(entries|entry-settings|reopen-windows|member-choices)(?:\/[^/]+(?:\/void|\/history)?)?$/.test(path);}
export function accountingRoute(db:ModuleDatabase,installation:string,actor:string,request:Request,input?:unknown,now=Date.now()){return run(async()=>{
 await requireModuleCapability(db,installation,actor,'hours.manage');clock(now);
 const url=new URL(request.url),parts=url.pathname.split('/').slice(3),kind=parts[0],id=parts[1],action=parts[2];if(id)string(id);
 if(kind==='member-choices'&&request.method==='GET'&&!action){
  url.searchParams.forEach((_,key)=>{if(id||!['active','q','after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpError(400,'Invalid member choice filter');});
  const label=(r:Row)=>({id:r.id,label:[r.first_name,r.last_name].filter(Boolean).join(' ').trim()||r.external_id,externalId:r.external_id,active:Boolean(r.active)});
  if(id){const row=await db.prepare(`SELECT id,first_name,last_name,external_id,active FROM members WHERE installation_id=? AND id=? AND ${staffFence}`).bind(installation,id,installation,actor).first<Row>();await requireModuleCapability(db,installation,actor,'hours.manage');if(!row)throw new HttpError(404,'Member choice is unavailable');return {status:200,body:label(row)};}
  const active=url.searchParams.get('active')??'true';if(!['true','false','all'].includes(active))throw new HttpError(400,'Invalid member active filter');
  const limit=number(Number(url.searchParams.get('limit')??50),1,100),after=string(url.searchParams.get('after')??'',128,false),query=string(url.searchParams.get('q')??'',100,false);
  const rows=(await db.prepare(`SELECT id,first_name,last_name,external_id,active FROM members WHERE installation_id=? AND id>? ${active==='all'?'':'AND active=?'} AND (?='' OR instr(lower(first_name||' '||last_name||' '||external_id),lower(?))>0) AND ${staffFence} ORDER BY id LIMIT ?`).bind(installation,after,...(active==='all'?[]:[Number(active==='true')]),query,query,installation,actor,limit+1).all<Row>()).results??[];
  await requireModuleCapability(db,installation,actor,'hours.manage');return {status:200,body:{items:rows.slice(0,limit).map(label),nextCursor:rows.length>limit?rows[limit-1].id:null}};
 }
 if(kind==='entries'&&request.method==='POST'&&!id){if(!obj(input))throw new HttpError(400,'Provide an hour object');string(input.expectedTimeZone,100);return {status:201,body:await save(db,installation,{channel:'staff',actor},input,now)};}
 if(kind==='entries'&&id&&((request.method==='PATCH'&&!action)||(request.method==='POST'&&action==='void')))return {status:200,body:await save(db,installation,{channel:'staff',actor},input,now,{id,void:action==='void'})};
 if(request.method==='GET'&&kind==='entries'){
  if(id){const row=await db.prepare('SELECT * FROM hours_entries WHERE installation_id=? AND id=?').bind(installation,id).first<Row>();if(!row)throw new HttpError(404,'Hour entry not found');if(!action)return {status:200,body:staffRow(row)};if(action!=='history')throw new HttpError(404,'Hour route not found');}
  const allowed=id?['after','limit']:['after','limit','memberId','activityId','status','from','to'];url.searchParams.forEach((_,key)=>{if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpError(400,'Invalid entry filter');});
  const limit=number(Number(url.searchParams.get('limit')??50),1,100),after=url.searchParams.get('after')??'';
  if(id){const cursor=after===''?-1:number(Number(after));const rows=(await db.prepare('SELECT * FROM hours_entry_revisions WHERE installation_id=? AND entry_id=? AND revision>? ORDER BY revision LIMIT ?').bind(installation,id,cursor,limit+1).all<Row>()).results??[];return {status:200,body:{items:rows.slice(0,limit).map(r=>({...staffRow(r),snapshot:staffRow(JSON.parse(r.snapshot))})),nextCursor:rows.length>limit?String(rows[limit-1].revision):null}};}
  string(after,128,false);const clauses=['installation_id=?','id>?'],values:unknown[]=[installation,after];
  for(const [parameter,column,op] of [['memberId','member_id','='],['activityId','activity_id','='],['status','status','='],['from','service_date','>='],['to','service_date','<=']]){const value=url.searchParams.get(parameter);if(value!==null){if(parameter==='from'||parameter==='to')date(value);else if(parameter==='status'&&!['counted','void'].includes(value))throw new HttpError(400,'Invalid entry status');else string(value);clauses.push(`${column}${op}?`);values.push(value);}}
  const rows=(await db.prepare(`SELECT * FROM hours_entries WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`).bind(...values,limit+1).all<Row>()).results??[];return {status:200,body:{items:rows.slice(0,limit).map(staffRow),nextCursor:rows.length>limit?rows[limit-1].id:null}};
 }
 if(kind==='entry-settings'&&!id){
  const row=await db.prepare('SELECT * FROM hours_entry_settings WHERE installation_id=?').bind(installation).first<Row>();if(!row)throw new HttpError(503,'Hour settings are unavailable');
  if(request.method==='GET'){const zone=(await db.prepare('SELECT time_zone FROM organization_settings WHERE installation_id=?').bind(installation).first<Row>())?.time_zone;return {status:200,body:{...staffRow(row),timeZone:zone,today:instantToCivil(now,zone).date}};}
  if(request.method==='PUT'){
   if(!obj(input))throw new HttpError(400,'Provide hour settings');unknownFields(input,['revision','reportingDays','reopenHours']);const revision=number(input.revision),days=number(input.reportingDays??row.reporting_days,1,365),hours=number(input.reopenHours??row.reopen_hours,1,168),audit=crypto.randomUUID();
   const result=await db.batch([db.prepare(`UPDATE hours_entry_settings SET reporting_days=?,reopen_hours=?,revision=revision+1 WHERE installation_id=? AND revision=? AND ${staffFence}`).bind(days,hours,installation,revision,installation,actor),db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,created_at) SELECT ?,?,?,'hours.settings.updated','hours',? WHERE changes()=1`).bind(audit,installation,actor,clock(now))]);
   if(result[0]?.meta?.changes!==1)throw new HttpError(409,'Hour settings or access changed; reload');return {status:200,body:{reportingDays:days,reopenHours:hours,revision:revision+1}};
  }
 }
 if(kind==='reopen-windows'){
  if(request.method==='GET'&&id&&!action){if(url.search)throw new HttpError(400,'Invalid reopen detail filter');const row=await db.prepare(`SELECT * FROM hours_reopen_windows WHERE installation_id=? AND id=? AND ${staffFence}`).bind(installation,id,installation,actor).first<Row>();await requireModuleCapability(db,installation,actor,'hours.manage');if(!row)throw new HttpError(404,'Reopen window not found');return {status:200,body:{...staffRow(row),active:!row.revoked&&row.starts_ms<=now&&row.expires_ms>now}};}
  if(request.method==='GET'&&!id){url.searchParams.forEach((_,key)=>{if(!['after','limit'].includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpError(400,'Invalid reopen filter');});const limit=number(Number(url.searchParams.get('limit')??50),1,100),after=string(url.searchParams.get('after')??'',128,false);const rows=(await db.prepare('SELECT * FROM hours_reopen_windows WHERE installation_id=? AND id>? ORDER BY id LIMIT ?').bind(installation,after,limit+1).all<Row>()).results??[];return {status:200,body:{items:rows.slice(0,limit).map(r=>({...staffRow(r),active:!r.revoked&&r.starts_ms<=now&&r.expires_ms>now})),nextCursor:rows.length>limit?rows[limit-1].id:null}};}
  if(!obj(input))throw new HttpError(400,'Provide a reopen window');
  let statement,windowId=id??crypto.randomUUID(),revision=0;
  if(request.method==='POST'&&!id){unknownFields(input,['activityId','durationHours']);const settings=await db.prepare('SELECT reopen_hours,revision FROM hours_entry_settings WHERE installation_id=?').bind(installation).first<Row>();if(!settings)throw new HttpError(503,'Hour settings are unavailable');const hours=number(input.durationHours??settings.reopen_hours,1,168),activityId=input.activityId===null?null:string(input.activityId);const zone=(await db.prepare('SELECT time_zone FROM organization_settings WHERE installation_id=?').bind(installation).first<Row>())?.time_zone,today=instantToCivil(now,zone).date;
   statement=db.prepare(`INSERT INTO hours_reopen_windows(installation_id,id,activity_id,starts_ms,expires_ms,actor_user_id,created_at) SELECT ?,?,?,?,?,?,? WHERE ${staffFence} AND EXISTS(SELECT 1 FROM hours_entry_settings WHERE installation_id=? AND revision=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND id=? AND mode='event' AND archived=0 AND service_date<?)) AND (SELECT count(*) FROM hours_reopen_windows WHERE installation_id=? AND revoked=0 AND expires_ms>?)<64`).bind(installation,windowId,activityId,now,now+hours*3600000,actor,clock(now),installation,actor,installation,settings.revision,activityId,installation,activityId,today,installation,now);
  }else if(request.method==='PATCH'&&id&&!action){unknownFields(input,['revision','revoked']);if(input.revoked!==true)throw new HttpError(400,'Revoke a window or create a new one');revision=number(input.revision)+1;statement=db.prepare(`UPDATE hours_reopen_windows SET revoked=1,revision=revision+1 WHERE installation_id=? AND id=? AND revision=? AND ${staffFence}`).bind(installation,id,revision-1,installation,actor);}else throw new HttpError(405,'Unsupported reopen operation');
  const result=await db.batch([statement,db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,?,?,?,'hours_reopen',?,? WHERE changes()=1`).bind(crypto.randomUUID(),installation,actor,id?'hours.reopen.revoked':'hours.reopen.created',windowId,clock(now))]);if(result[0]?.meta?.changes!==1)throw new HttpError(409,'Event, window limit or access changed; reload');return {status:id?200:201,body:{id:windowId,revision}};
 }
 throw new HttpError(405,'Unsupported hour operation');
});}

/** Installation restore validation runs before any destructive statement. */
export function validateAccountingBackup(tables:Record<string,Row[]>,exportedAt:string){
 const fail=()=>{throw new HttpError(400,'Invalid hour accounting backup');};
 const map=(rows:Row[],key='id')=>{const result=new Map<string,Row>();for(const row of rows){if(row.installation_id!=='primary'||typeof row[key]!=='string'||!row[key].length||row[key].length>128||result.has(row[key]))fail();result.set(row[key],row);}return result;};
 const entries=map(tables.hours_entries??[]),activities=map(tables.hours_activities??[]),members=map(tables.members??[]),users=map(tables.users??[]);
 const settings=tables.hours_entry_settings??[];if(settings.length!==1||settings[0].installation_id!=='primary')fail();number(settings[0].reporting_days,1,365);number(settings[0].reopen_hours,1,168);number(settings[0].revision);
 const exportMs=Date.parse(exportedAt);if(!Number.isFinite(exportMs))fail();
 function validateEntry(row:Row){
  if(!obj(row)||Object.keys(row).sort().join(',')!==[...accountingColumns.hours_entries].sort().join(','))fail();
  if(row.installation_id!=='primary'||!members.has(row.member_id)||!activities.has(row.activity_id)||(row.actor_user_id!==null&&!users.has(row.actor_user_id)))fail();
  if(activities.get(row.activity_id)!.service_date!==row.service_date)fail();
  string(row.id);number(row.revision);string(row.created_at,40);string(row.updated_at,40);if(!Number.isFinite(Date.parse(row.created_at))||!Number.isFinite(Date.parse(row.updated_at))||Date.parse(row.updated_at)<Date.parse(row.created_at)||Date.parse(row.updated_at)>exportMs)fail();string(row.task_notes,4000,false);
  if(!['counted','void'].includes(row.status)||!['staff','public','discord'].includes(row.channel)||row.attribution!==({staff:'staff_recorded',public:'self_asserted',discord:'linked_discord'} as Row)[row.channel]||(row.channel==='staff')!==(row.actor_user_id!==null)||![0,1].includes(row.end_next_day))fail();
  const calculated=timing({startLocal:row.start_local,endLocal:row.end_local,endNextDay:Boolean(row.end_next_day),startOccurrence:row.start_occurrence,endOccurrence:row.end_occurrence},date(row.service_date),string(row.time_zone,100),exportMs);
  for(const key of Object.keys(calculated))if(calculated[key as keyof typeof calculated]!==row[key])fail();
 }
 for(const row of entries.values())validateEntry(row);
 const byMember=new Map<string,Row[]>();for(const row of entries.values())if(row.status==='counted'){const list=byMember.get(row.member_id)??[];list.push(row);byMember.set(row.member_id,list);}
 for(const rows of byMember.values()){rows.sort((a,b)=>a.start_ms-b.start_ms);for(let i=1;i<rows.length;i++)if(rows[i-1].end_ms>rows[i].start_ms)fail();}
 const revisions=new Map<string,Map<number,Row>>();
 for(const row of tables.hours_entry_revisions??[]){if(row.installation_id!=='primary'||!entries.has(row.entry_id)||(row.actor_user_id!==null&&!users.has(row.actor_user_id)))fail();number(row.revision);if(!['created','corrected','voided'].includes(row.action))fail();string(row.reason,4000,row.action!=='created');string(row.created_at,40);let snapshot:Row;try{snapshot=JSON.parse(row.snapshot);}catch{fail();return;}validateEntry(snapshot!);if(snapshot!.id!==row.entry_id||snapshot!.revision!==row.revision||snapshot!.member_id!==row.member_id||snapshot!.activity_id!==row.activity_id)fail();if(row.created_at!==snapshot!.updated_at||(row.action==='created'?row.actor_user_id!==snapshot!.actor_user_id:row.actor_user_id===null))fail();if((row.revision===0)!==(row.action==='created')||(row.action==='voided')!==(snapshot!.status==='void'))fail();const history=revisions.get(row.entry_id)??new Map<number,Row>();if(history.has(row.revision))fail();history.set(row.revision,snapshot!);revisions.set(row.entry_id,history);}
 for(const entry of entries.values()){const history=revisions.get(entry.id);if(!history||history.size!==entry.revision+1)fail();for(let i=0;i<=entry.revision;i++){const saved=history!.get(i);if((i>0&&history!.get(i-1)?.status==='void')||!saved||saved.channel!==entry.channel||saved.attribution!==entry.attribution||saved.actor_user_id!==entry.actor_user_id||saved.time_zone!==entry.time_zone||saved.created_at!==entry.created_at)fail();}if(canonical(history!.get(entry.revision)!)!==canonical(entry))fail();}
 const keys=new Set<string>(),keyEntries=new Set<string>();
 for(const row of tables.hours_submission_keys??[]){const entry=entries.get(row.entry_id),key=row.channel+':'+row.key_hash;if(row.installation_id!=='primary'||!entry||row.channel!==entry.channel||typeof row.key_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.key_hash)||typeof row.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(row.fingerprint)||keys.has(key)||keyEntries.has(row.entry_id))fail();let receipt;try{receipt=JSON.parse(row.receipt);}catch{fail();}const original=revisions.get(row.entry_id)!.get(0)!;if(!obj(receipt)||canonical(receipt)!==canonical(Object.fromEntries(receiptColumns.map(c=>[c,original[c]]))))fail();string(row.created_at,40);keys.add(key);keyEntries.add(row.entry_id);}
 if(keyEntries.size!==entries.size)fail();
 for(const row of map(tables.hours_reopen_windows??[]).values()){number(row.revision);if(!users.has(row.actor_user_id)||![0,1].includes(row.revoked)||!Number.isSafeInteger(row.starts_ms)||!Number.isSafeInteger(row.expires_ms)||row.expires_ms<=row.starts_ms||row.expires_ms-row.starts_ms>604800000)fail();if(row.activity_id!==null&&activities.get(row.activity_id)?.mode!=='event')fail();string(row.created_at,40);}
}
