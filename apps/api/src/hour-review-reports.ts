import { addCalendarDays, CivilTimeError } from '@lancerlogin/shared/civil-time';
import { HttpError } from './http-error.ts';
import { requireModuleCapability, type ModuleDatabase } from './platform-modules.ts';
import { applyReviewedHourChange } from './hour-accounting.ts';

type Row=Record<string,any>;
export const reviewColumns={
 hours_correction_requests:['installation_id','id','channel','attribution','requester_member_id','claimed_member_id','claimed_receipt_id','claimed_activity_id','claimed_service_date','message','key_hash','fingerprint','status','revision','created_at','resolved_at'],
 hours_correction_resolutions:['installation_id','request_id','action','note','actor_user_id','entry_id','entry_revision','created_at'],
} as const;
const staffFence=`EXISTS(SELECT 1 FROM users u JOIN platform_module_configuration c ON c.installation_id=u.installation_id LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id=? AND u.id=? AND u.active=1 AND c.hours_enabled=1 AND (u.role='admin' OR g.hours_manage=1))`;
const moduleFence=`EXISTS(SELECT 1 FROM platform_module_configuration WHERE installation_id=? AND hours_enabled=1)`;
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
function text(v:unknown,max=128,empty=false){if(typeof v!=='string'||v.length>max||(!empty&&!v.trim()))throw new HttpError(400,'Invalid correction field');return v.trim();}
function integer(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER-1){if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw new HttpError(400,'Invalid revision or limit');return Number(v);}
function date(v:unknown){try{return addCalendarDays(text(v,10),0);}catch{throw new HttpError(400,'Invalid service date');}}
function fields(input:unknown,allowed:string[]):asserts input is Row {if(!object(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw new HttpError(400,'Invalid correction object');}
function parameters(url:URL,allowed:string[]){url.searchParams.forEach((_,k)=>{if(!allowed.includes(k)||url.searchParams.getAll(k).length!==1)throw new HttpError(400,'Invalid review filter');});}
function instant(now:number){if(!Number.isSafeInteger(now)||!Number.isFinite(new Date(now).getTime()))throw new HttpError(400,'Invalid current instant');return new Date(now).toISOString();}
const hash=async(v:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const canonical=(v:Row)=>JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])));
const staffRow=(row:Row)=>Object.fromEntries(Object.entries(row).filter(([k])=>!['installation_id','key_hash','fingerprint'].includes(k)).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),v]));
const acknowledgement=(id:string)=>({accepted:true,reference:id});

/** Server-only intake; adapters authenticate Discord signatures and apply abuse controls.
 * Receipt/activity/member fields are claims, never a lookup permission or proof of ownership.
 */
export const requestSelfAssertedHourCorrection=(db:ModuleDatabase,installation:string,input:unknown,now=Date.now())=>intake(db,installation,input,now);
export const requestLinkedDiscordHourCorrection=(db:ModuleDatabase,installation:string,verifiedDiscordUserId:string,input:unknown,now=Date.now(),discordProviderIv?:string)=>intake(db,installation,input,now,text(verifiedDiscordUserId,24),discordProviderIv);
async function intake(db:ModuleDatabase,installation:string,input:unknown,now:number,discordUserId?:string,discordProviderIv?:string){
 const channel=discordUserId?'discord':'public';
 if(!await db.prepare(`SELECT 1 WHERE ${moduleFence}`).bind(installation).first())throw new HttpError(403,'Hour Tracking is unavailable');
 fields(input,[...(discordUserId?[]:['memberId']),'receiptId','activityId','serviceDate','message','idempotencyKey']);
 const key=text(input.idempotencyKey);if(key.length<16)throw new HttpError(400,'Use a submission key of 16–128 characters');
 const claim={memberId:discordUserId?null:text(input.memberId),receiptId:input.receiptId==null?null:text(input.receiptId),activityId:input.activityId==null?null:text(input.activityId),serviceDate:input.serviceDate==null?null:date(input.serviceDate),message:text(input.message,4000)};
 const keyHash=await hash(key),fingerprint=await hash(canonical({...claim,channel,discordUserId:discordUserId??null}));
 const read=()=>db.prepare('SELECT id,fingerprint FROM hours_correction_requests WHERE installation_id=? AND channel=? AND key_hash=?').bind(installation,channel,keyHash).first<Row>();
 const receipt=(row:Row)=>{if(row.fingerprint!==fingerprint)throw new HttpError(409,'Request key was already used for different input');return acknowledgement(row.id);};
 const prior=await read();if(prior)return receipt(prior);
 const id=crypto.randomUUID(),createdAt=instant(now),memberColumn=discordUserId?'discord_user_id':'external_id',identity=discordUserId??claim.memberId;
 const memberSQL=`SELECT id FROM members WHERE installation_id=? AND ${memberColumn}=? AND active=1`;
 const results=await db.batch([
  db.prepare(`INSERT INTO hours_correction_requests(installation_id,id,channel,attribution,requester_member_id,claimed_member_id,claimed_receipt_id,claimed_activity_id,claimed_service_date,message,key_hash,fingerprint,created_at) SELECT ?,?,?,?,(${memberSQL}),?,?,?,?,?,?,?,? WHERE ${moduleFence} ${discordUserId?`AND EXISTS(${memberSQL})`:''} ${discordProviderIv?`AND EXISTS(SELECT 1 FROM encrypted_integrations i JOIN installations x ON x.id=i.installation_id WHERE i.installation_id=? AND i.provider='discord' AND i.iv=? AND i.verified_at IS NOT NULL AND x.discord_enabled=1)`:''} AND NOT EXISTS(SELECT 1 FROM hours_correction_requests WHERE installation_id=? AND channel=? AND key_hash=?)`).bind(installation,id,channel,discordUserId?'linked_discord':'self_asserted',installation,identity,claim.memberId,claim.receiptId,claim.activityId,claim.serviceDate,claim.message,keyHash,fingerprint,createdAt,installation,...(discordUserId?[installation,identity]:[]),...(discordProviderIv?[installation,discordProviderIv]:[]),installation,channel,keyHash),
  db.prepare(`INSERT INTO audit_log(id,installation_id,action,target_type,target_id,created_at) SELECT ?,?,'hours.request.received','hour_correction_request',?,? WHERE changes()=1`).bind(crypto.randomUUID(),installation,id,createdAt),
 ]);
 const saved=await read();if(saved)return receipt(saved);
 if(results[0]?.meta?.changes!==1)throw new HttpError(403,'Hour correction intake is unavailable; check pairing or try again');
 throw new HttpError(503,'Hour correction persistence could not be verified');
}

export function isHourReviewPath(path:string){return /^\/admin\/hours\/(reports|correction-requests)(?:\/[^/]+(?:\/history|\/resolve)?)?$/.test(path);}
export async function hourReviewRoute(db:ModuleDatabase,installation:string,actor:string,request:Request,input?:unknown,now=Date.now()){
 await requireModuleCapability(db,installation,actor,'hours.manage');
 const url=new URL(request.url),[kind,id,action]=url.pathname.split('/').slice(3);if(id)text(id);
 if(kind==='reports'&&!id&&request.method==='GET')return {status:200,body:await report(db,installation,actor,url)};
 if(kind!=='correction-requests')throw new HttpError(405,'Unsupported review operation');
 if(request.method==='GET'){
  parameters(url,id?[]:['status','after','limit','memberId']);
  if(id){
   const results=await db.batch([
    db.prepare(`SELECT * FROM hours_correction_requests WHERE installation_id=? AND id=? AND ${staffFence}`).bind(installation,id,installation,actor),
    db.prepare(`SELECT * FROM hours_correction_resolutions WHERE installation_id=? AND request_id=? AND ${staffFence}`).bind(installation,id,installation,actor),
   ]);
   await requireModuleCapability(db,installation,actor,'hours.manage');const row=results[0]?.results?.[0] as Row|undefined,resolution=results[1]?.results?.[0] as Row|undefined;
   if(!row)throw new HttpError(404,'Correction request not found');
   if(action==='history')return {status:200,body:{items:[{type:'received',attribution:row.attribution,createdAt:row.created_at},...(resolution?[{type:'resolved',...staffRow(resolution)}]:[])],nextCursor:null}};
   if(action)throw new HttpError(405,'Unsupported review operation');
   return {status:200,body:{...staffRow(row),resolution:resolution?staffRow(resolution):null}};
  }
  const status=url.searchParams.get('status')??'open';if(!['open','resolved','all'].includes(status))throw new HttpError(400,'Invalid request status');
  const limit=integer(Number(url.searchParams.get('limit')??50),1,100),after=text(url.searchParams.get('after')??'',128,true),member=url.searchParams.has('memberId')?text(url.searchParams.get('memberId')):null;
  const rows=(await db.prepare(`SELECT * FROM hours_correction_requests WHERE installation_id=? AND id>? AND (?='all' OR status=?) AND (? IS NULL OR requester_member_id=?) AND ${staffFence} ORDER BY id LIMIT ?`).bind(installation,after,status,status,member,member,installation,actor,limit+1).all<Row>()).results??[];
  await requireModuleCapability(db,installation,actor,'hours.manage');return {status:200,body:{items:rows.slice(0,limit).map(staffRow),nextCursor:rows.length>limit?rows[limit-1].id:null}};
 }
 if(request.method!=='POST'||!id||action!=='resolve')throw new HttpError(405,'Unsupported review operation');
 parameters(url,[]);fields(input,['revision','action','note','entryId','entryRevision','correction']);
 const revision=integer(input.revision,0,0),note=text(input.note,4000),resolutionAction=text(input.action,32),createdAt=instant(now);
 if(!['acknowledged','dismissed','corrected','voided'].includes(resolutionAction))throw new HttpError(400,'Invalid resolution action');
 const entryId=input.entryId==null?null:text(input.entryId),entryRevision=input.entryRevision==null?null:integer(input.entryRevision);
 if((entryId===null)!==(entryRevision===null))throw new HttpError(400,'Provide both reviewed entry identity and revision');
 if(resolutionAction==='corrected'||resolutionAction==='voided'){
  if(!entryId)throw new HttpError(400,'Select the entry and current revision to change');
  if(resolutionAction==='voided'&&input.correction!==undefined)throw new HttpError(400,'Voids do not change recorded fields');
  const correction=resolutionAction==='corrected'?input.correction:{};
  if(!object(correction)||'revision'in correction||'reason'in correction)throw new HttpError(400,'Provide correction fields separately from review metadata');
  const entry=await applyReviewedHourChange(db,installation,actor,{...correction,revision:entryRevision,reason:note},{id:entryId,void:resolutionAction==='voided'},{requestId:id,requestRevision:revision,note},now);
  return {status:200,body:{id,revision:1,status:'resolved',entry}};
 }
 if(input.correction!==undefined)throw new HttpError(400,'This resolution does not change an entry');
 const auditId=crypto.randomUUID();
 const results=await db.batch([
  db.prepare(`UPDATE hours_correction_requests SET status='resolved',revision=1,resolved_at=? WHERE installation_id=? AND id=? AND status='open' AND revision=? AND created_at<=? AND ${staffFence} AND (? IS NULL OR EXISTS(SELECT 1 FROM hours_entries WHERE installation_id=? AND id=? AND revision=?))`).bind(createdAt,installation,id,revision,createdAt,installation,actor,entryId,installation,entryId,entryRevision),
  db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,'hours.request.resolved','hour_correction_request',?,?,? WHERE changes()=1`).bind(auditId,installation,actor,id,JSON.stringify({action:resolutionAction,entryId,entryRevision}),createdAt),
  db.prepare(`INSERT INTO hours_correction_resolutions(installation_id,request_id,action,note,actor_user_id,entry_id,entry_revision,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_log WHERE id=?)`).bind(installation,id,resolutionAction,note,actor,entryId,entryRevision,createdAt,auditId),
 ]);
 if(results[0]?.meta?.changes!==1)throw new HttpError(409,'Request, reviewed entry or access changed; reload');
 return {status:200,body:{id,revision:1,status:'resolved'}};
}

async function report(db:ModuleDatabase,installation:string,actor:string,url:URL){
 parameters(url,['from','to','memberId','activityId','categoryId','teamId','groupBy','limit','after']);
 const from=date(url.searchParams.get('from')),to=date(url.searchParams.get('to'));
 // Calendar comparison avoids UTC parsing's special treatment of years 00–99.
 let maximum:string;try{maximum=addCalendarDays(from,3659);}catch(error){if(!(error instanceof CivilTimeError))throw error;maximum='9999-12-31';}
 if(to<from||to>maximum)throw new HttpError(400,'Choose a report period of at most 3660 service dates');
 const groupBy=url.searchParams.get('groupBy')??'member',groups:Record<string,string>={member:'e.member_id',activity:'e.activity_id',category:'a.category_id',team:'a.team_id'};
 if(!Object.hasOwn(groups,groupBy))throw new HttpError(400,'Invalid report grouping');
 const limit=integer(Number(url.searchParams.get('limit')??50),1,100),after=url.searchParams.has('after')?text(url.searchParams.get('after'),129):null;
 if(after!==null&&after!=='0'&&(!after.startsWith('1')||after.length<2))throw new HttpError(400,'Invalid report cursor');
 const clauses=["e.installation_id=?","e.status='counted'",'e.service_date>=?','e.service_date<=?',staffFence],values:unknown[]=[installation,from,to,installation,actor];
 for(const [param,column] of Object.entries({memberId:'e.member_id',activityId:'e.activity_id',categoryId:'a.category_id',teamId:'a.team_id'})){if(url.searchParams.has(param)){clauses.push(`${column}=?`);values.push(text(url.searchParams.get(param)));}}
 const source=`FROM hours_entries e JOIN hours_activities a ON a.installation_id=e.installation_id AND a.id=e.activity_id WHERE ${clauses.join(' AND ')}`;
 const metrics='COALESCE(SUM(e.duration_minutes),0) AS minutes,COUNT(*) AS entryCount,COUNT(DISTINCT e.member_id) AS distinctParticipants',group=groups[groupBy],cursor=`CASE WHEN ${group} IS NULL THEN '0' ELSE '1'||${group} END`;
 const results=await db.batch([
  db.prepare(`SELECT ${metrics} ${source}`).bind(...values),
  db.prepare(`SELECT ${group} AS id,${cursor} AS cursor,${metrics} ${source} AND (? IS NULL OR ${cursor}>?) GROUP BY ${group} ORDER BY cursor LIMIT ?`).bind(...values,after,after,limit+1),
 ]);
 await requireModuleCapability(db,installation,actor,'hours.manage');
 const totals=results[0]?.results?.[0] as Row|undefined,rows=results[1]?.results as Row[]|undefined;
 if(!totals||!rows||[totals,...rows].some(r=>['minutes','entryCount','distinctParticipants'].some(k=>!Number.isSafeInteger(r[k])||r[k]<0)))throw new HttpError(503,'Report totals could not be verified');
 return {from,to,groupBy,teamAttribution:'primary',totals,items:rows.slice(0,limit).map(({cursor,...row})=>row),nextCursor:rows.length>limit?rows[limit-1].cursor:null};
}

/** Graph validation before installation replacement; self-asserted claims remain unverified strings. */
export function validateReviewBackup(tables:Record<string,Row[]>,exportedAt:string){
 const fail=()=>{throw new HttpError(400,'Invalid hour review backup');};
 const members=new Set(tables.members.map(r=>r.id)),users=new Set(tables.users.map(r=>r.id)),history=new Map(tables.hours_entry_revisions.map(r=>[r.entry_id+':'+r.revision,r]));
 const requests=new Map<string,Row>(),keys=new Set<string>(),resolutions=new Set<string>(),exportMs=Date.parse(exportedAt);
 for(const row of tables.hours_correction_requests??[]){
  text(row.id);if(row.installation_id!=='primary'||requests.has(row.id)||!['public','discord'].includes(row.channel)||row.attribution!==(row.channel==='public'?'self_asserted':'linked_discord')||(row.requester_member_id!==null&&!members.has(row.requester_member_id))||(row.channel==='discord'&&(row.requester_member_id===null||row.claimed_member_id!==null)))fail();
  if(row.channel==='public')text(row.claimed_member_id);for(const field of ['claimed_receipt_id','claimed_activity_id'])if(row[field]!==null)text(row[field]);if(row.claimed_service_date!==null)date(row.claimed_service_date);text(row.message,4000);
  if(!/^[a-f0-9]{64}$/.test(row.key_hash)||!/^[a-f0-9]{64}$/.test(row.fingerprint))fail();const key=row.channel+':'+row.key_hash;if(keys.has(key))fail();keys.add(key);
  const created=Date.parse(row.created_at),resolved=Date.parse(row.resolved_at);if(typeof row.created_at!=='string'||!Number.isFinite(created)||created>exportMs)fail();
  if(row.status==='open'){if(row.revision!==0||row.resolved_at!==null)fail();}else if(row.status==='resolved'){if(row.revision!==1||typeof row.resolved_at!=='string'||!Number.isFinite(resolved)||resolved<created||resolved>exportMs)fail();}else fail();
  requests.set(row.id,row);
 }
 for(const row of tables.hours_correction_resolutions??[]){
  const request=requests.get(row.request_id);if(row.installation_id!=='primary'||!request||request.status!=='resolved'||resolutions.has(row.request_id)||!users.has(row.actor_user_id)||row.created_at!==request.resolved_at||!['acknowledged','dismissed','corrected','voided'].includes(row.action))fail();text(row.note,4000);
  if(row.entry_id===null){if(row.entry_revision!==null||['corrected','voided'].includes(row.action))fail();}else{integer(row.entry_revision);const revision=history.get(row.entry_id+':'+row.entry_revision);if(!revision||Date.parse(revision.created_at)>Date.parse(row.created_at))fail();if(['corrected','voided'].includes(row.action)&&(revision!.action!==row.action||revision!.created_at!==row.created_at||revision!.reason!==row.note||revision!.actor_user_id!==row.actor_user_id))fail();}
  resolutions.add(row.request_id);
 }
 for(const row of requests.values())if((row.status==='resolved')!==resolutions.has(row.id))fail();
}
