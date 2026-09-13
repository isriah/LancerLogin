import type {Env} from './index.ts';
import {HttpError} from './http-error.ts';
import {requireModuleCapability,requireModuleEnabled} from './platform-modules.ts';
import {instantToCivil} from '@lancerlogin/shared/civil-time';
import {eventProviderCapability,eventProviderFence,PublicationReviewError,type EventProvider,type PublicationSnapshot} from './provider-event-capabilities.ts';
type Row=Record<string,any>;
export const publicationColumns={
 hours_publication_intents:['installation_id','activity_id','provider','enabled','revision','generation','needs_review','activity_revision','actor_user_id','snapshot_json','updated_at'],
 hours_publication_generations:['installation_id','activity_id','provider','generation','connection_generation','destination','application_id','marker','provider_event_id','abandoned','created_at'],
 hours_publication_operations:['installation_id','activity_id','provider','generation','action','revision','status','phase','snapshot_json','actor_user_id','activity_revision','attempts','next_attempt_ms','lease_token','lease_expires_ms','last_error','updated_at'],
} as const;
const staffFence="EXISTS(SELECT 1 FROM users u JOIN platform_module_configuration c ON c.installation_id=u.installation_id LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id='primary' AND u.id=? AND u.active=1 AND c.hours_enabled=1 AND (u.role='admin' OR g.hours_manage=1))";
const opKey="installation_id='primary' AND activity_id=? AND provider=? AND generation=? AND action=?";
const keys=(o:Row)=>[o.activity_id,o.provider,o.generation,o.action];
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown)=>{if(!Number.isSafeInteger(v)||Number(v)<0||Number(v)>=Number.MAX_SAFE_INTEGER)throw new HttpError(400,'Provide the current publication revision');return Number(v);};
const text=(v:unknown,max:number,required=false)=>{if(typeof v!=='string'||v.length>max||required&&!v.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))throw new HttpError(400,'Invalid publication text');return v.trim();};
const hash=async(v:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))),b=>b.toString(16).padStart(2,'0')).join('');
const targetKey=(c:{generation:string;destination:string;applicationId:string})=>hash(JSON.stringify([c.generation,c.destination,c.applicationId]));
const provider=(v:string):EventProvider=>{if(v!=='google'&&v!=='discord')throw new HttpError(404,'Publication provider not found');return v;};
const fields=(input:Row,allowed:string[])=>{if(Object.keys(input).some(k=>!allowed.includes(k)))throw new HttpError(400,'Unknown publication field');};
function snapshot(input:unknown,a:Row,p:EventProvider,now:number,restoring=false):PublicationSnapshot{
 if(!object(input))throw new HttpError(400,'Review the explicit publication fields');fields(input,['title','description','location','startsAt','endsAt',...(restoring?['serviceDate','timeZone']:[])]);
 const s:PublicationSnapshot={title:text(input.title,p==='discord'?100:150,true),description:text(input.description,p==='discord'?900:3000),location:text(input.location,p==='discord'?100:500,p==='discord'),serviceDate:a.service_date,timeZone:a.planning_time_zone,startsAt:input.startsAt,endsAt:input.endsAt};
 try{if(typeof s.timeZone!=='string'||s.timeZone.length>100)throw Error();new Intl.DateTimeFormat('en',{timeZone:s.timeZone}).format(0);}catch{throw new HttpError(400,'Invalid publication time zone');}
 if((s.startsAt===null)!==(s.endsAt===null))throw new HttpError(400,'Provide both publication times or neither');
 if(s.startsAt!==null){
  for(const clock of [s.startsAt,s.endsAt]){
   if(typeof clock!=='string'||!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(clock)||!Number.isFinite(Date.parse(clock))||new Date(clock.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==clock.slice(0,10))throw new HttpError(400,'Use explicit publication instants');
  }
  if(Date.parse(s.endsAt!)<=Date.parse(s.startsAt)||instantToCivil(Date.parse(s.startsAt),s.timeZone).date!==s.serviceDate||instantToCivil(Date.parse(s.endsAt!)-1,s.timeZone).date!==s.serviceDate)throw new HttpError(400,'Publication times must fit this activity date');
 }
 if(p==='discord'&&(s.startsAt===null||!restoring&&Date.parse(s.startsAt)<=now))throw new HttpError(400,'Discord needs explicit future start/end times and a location');
 return s;
}
const intentWhere="installation_id='primary' AND activity_id=? AND provider=?";
async function detail(env:Env,actor:string,a:Row){
 const db=env.DB!,intents=(await db.prepare("SELECT * FROM hours_publication_intents WHERE installation_id='primary' AND activity_id=?").bind(a.id).all<Row>()).results??[];
 const generations=(await db.prepare("SELECT g.*,o.action,o.revision AS operation_revision,o.status,o.phase,o.last_error,o.attempts,o.lease_expires_ms FROM hours_publication_generations g JOIN hours_publication_operations o USING(installation_id,activity_id,provider,generation) WHERE g.installation_id='primary' AND g.activity_id=? ORDER BY g.generation DESC,o.action LIMIT 101").bind(a.id).all<Row>()).results??[];
 if(generations.length>100)throw new HttpError(409,'Publication history exceeds the supported review limit');
 const providers=await Promise.all((['google','discord'] as const).map(async p=>{
  const row=intents.find(i=>i.provider===p);let target:unknown={ready:false};try{const c=await eventProviderCapability(env,p);target={ready:true,key:await targetKey(c),destination:c.destination,applicationId:c.applicationId};}catch{}
  return {provider:p,enabled:Boolean(row?.enabled),revision:row?.revision??0,generation:row?.generation??0,needsReview:Boolean(row?.needs_review),reviewedActivityRevision:row?.activity_revision??null,snapshot:row?JSON.parse(row.snapshot_json):null,target,
   operations:generations.filter(g=>g.provider===p).map(g=>({generation:g.generation,destination:g.destination,applicationId:g.application_id,eventId:g.provider_event_id,abandoned:Boolean(g.abandoned),action:g.action,revision:g.operation_revision,status:g.status,phase:g.phase,error:g.last_error,attempts:g.attempts}))};
 }));await requireModuleCapability(db,'primary',actor,'hours.manage');return {activityId:a.id,activityRevision:a.revision,archived:Boolean(a.archived),providers};
}
export const isPublicationPath=(path:string)=>/^\/admin\/hours\/activities\/[^/]+\/publications(?:\/(google|discord)(?:\/retry)?)?$/.test(path);
export async function hoursPublicationRoute(env:Env,actor:string,request:Request,input?:unknown,now=Date.now()){
 const db=env.DB!;await requireModuleCapability(db,'primary',actor,'hours.manage');
 const match=/^\/admin\/hours\/activities\/([^/]+)\/publications(?:\/(google|discord)(\/retry)?)?$/.exec(new URL(request.url).pathname);if(!match)throw new HttpError(404,'Publication route not found');
 const id=text(decodeURIComponent(match[1]),128,true),a=await db.prepare("SELECT * FROM hours_activities WHERE installation_id='primary' AND id=? AND mode='event'").bind(id).first<Row>();if(!a)throw new HttpError(404,'Hour event not found');
 if(request.method==='GET'&&!match[2])return detail(env,actor,a);
 if(!object(input)||!match[2])throw new HttpError(400,'Provide publication settings');const p=provider(match[2]),updatedAt=new Date(now).toISOString();
 if(request.method==='POST'&&match[3]){
  fields(input,['generation','action','revision']);const gen=integer(input.generation),rev=integer(input.revision);if(!['upsert','delete'].includes(input.action))throw new HttpError(400,'Invalid publication retry');
  const o=await db.prepare('SELECT * FROM hours_publication_operations WHERE '+opKey).bind(id,p,gen,input.action).first<Row>();
  if(!o||o.revision!==rev||o.status==='complete'||(o.lease_expires_ms??0)>now)throw new HttpError(409,'Publication operation changed or is still running');
  const g=await db.prepare('SELECT * FROM hours_publication_generations WHERE '+intentWhere+' AND generation=?').bind(id,p,gen).first<Row>(),c=await eventProviderCapability(env,p);
  if(!g||c.generation!==g.connection_generation||c.destination!==g.destination||c.applicationId!==g.application_id)throw new HttpError(409,'Old publication destination needs manual provider review; it cannot be retargeted');
  const result=await db.batch([db.prepare(`UPDATE hours_publication_operations SET status='pending',revision=revision+1,actor_user_id=?,attempts=0,next_attempt_ms=?,lease_token=NULL,lease_expires_ms=NULL,last_error=NULL,updated_at=? WHERE ${opKey} AND revision=? AND status!='complete' AND (lease_expires_ms IS NULL OR lease_expires_ms<=?) AND ${staffFence} AND ${eventProviderFence(p)} AND (action='delete' OR EXISTS(SELECT 1 FROM hours_publication_intents i WHERE i.installation_id=hours_publication_operations.installation_id AND i.activity_id=hours_publication_operations.activity_id AND i.provider=hours_publication_operations.provider AND i.generation=hours_publication_operations.generation AND i.enabled=1 AND i.needs_review=0))`).bind(actor,now,updatedAt,id,p,gen,input.action,rev,now,actor,c.signature),db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,'primary',?,'hours.publication.retry','hour_activity',?,? WHERE changes()=1").bind(crypto.randomUUID(),actor,id,updatedAt)]);
  if(result[0]?.meta?.changes!==1)throw new HttpError(409,'Review current publication fields and authority first');return detail(env,actor,a);
 }
 if(request.method!=='PUT'||match[3])throw new HttpError(405,'Publication method not allowed');
 fields(input,['revision','activityRevision','enabled','snapshot','targetKey']);const rev=integer(input.revision),activityRev=integer(input.activityRevision);if(typeof input.enabled!=='boolean')throw new HttpError(400,'Choose publication explicitly');
 const previous=await db.prepare('SELECT * FROM hours_publication_intents WHERE '+intentWhere).bind(id,p).first<Row>();if((previous?.revision??0)!==rev||a.revision!==activityRev)throw new HttpError(409,'Event or publication changed; reload before review');
 const old=previous?.generation?await db.prepare('SELECT * FROM hours_publication_generations WHERE '+intentWhere+' AND generation=?').bind(id,p,previous.generation).first<Row>():null;
 const c=input.enabled?await eventProviderCapability(env,p):null;
 if(input.enabled&&(a.archived||input.targetKey!==await targetKey(c!)))throw new HttpError(409,'Review the current provider destination before publishing');
 if(!input.enabled&&(input.snapshot!==undefined||input.targetKey!==undefined))throw new HttpError(400,'Disabling does not accept new publication content');
 const content=input.enabled?JSON.stringify(snapshot(input.snapshot,a,p,now)):previous?.snapshot_json??'{}';
 const reuse=Boolean(input.enabled&&previous?.enabled&&old&&!old.abandoned&&old.connection_generation===c!.generation&&old.destination===c!.destination&&old.application_id===c!.applicationId),gen=input.enabled?(reuse?previous!.generation:(previous?.generation??0)+1):previous?.generation??0;
 if(gen>20)throw new HttpError(409,'Publication generation limit reached; review historical destinations');
 const marker=crypto.randomUUID().replaceAll('-',''),audit=crypto.randomUUID(),guard=`${staffFence} AND EXISTS(SELECT 1 FROM hours_activities WHERE installation_id='primary' AND id=? AND revision=?)${c?' AND '+eventProviderFence(p):''}`,guardValues=[actor,id,activityRev,...(c?[c.signature]:[])];
 const mutation=previous?db.prepare(`UPDATE hours_publication_intents SET enabled=?,revision=revision+1,generation=?,needs_review=0,activity_revision=?,actor_user_id=?,snapshot_json=?,updated_at=? WHERE ${intentWhere} AND revision=? AND ${guard}`).bind(Number(input.enabled),gen,activityRev,actor,content,updatedAt,id,p,rev,...guardValues)
  :db.prepare(`INSERT INTO hours_publication_intents(installation_id,activity_id,provider,enabled,revision,generation,activity_revision,actor_user_id,snapshot_json,updated_at) SELECT 'primary',?,?,?,1,?,?,?,?,? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM hours_publication_intents WHERE ${intentWhere})`).bind(id,p,Number(input.enabled),gen,activityRev,actor,content,updatedAt,...guardValues,id,p);
 const did="EXISTS(SELECT 1 FROM audit_log WHERE id=?)",statements=[mutation,db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,'primary',?,'hours.publication.reviewed','hour_activity',?,? WHERE changes()=1").bind(audit,actor,id,updatedAt)];
 if(old&&(!input.enabled||!reuse)){
  statements.push(db.prepare(`UPDATE hours_publication_generations SET abandoned=1 WHERE ${intentWhere} AND generation=? AND ${did}`).bind(id,p,old.generation,audit));
  statements.push(db.prepare(`UPDATE hours_publication_operations SET status='review',last_error='Publication was disabled or replaced' WHERE ${intentWhere} AND generation=? AND action='upsert' AND status!='complete' AND ${did}`).bind(id,p,old.generation,audit));
  statements.push(db.prepare(`INSERT INTO hours_publication_operations(installation_id,activity_id,provider,generation,action,snapshot_json,actor_user_id,activity_revision,updated_at) SELECT 'primary',?,?,?,'delete',?,?,?,? WHERE ${did} ON CONFLICT(installation_id,activity_id,provider,generation,action) DO NOTHING`).bind(id,p,old.generation,previous!.snapshot_json,actor,activityRev,updatedAt,audit));
 }
 if(input.enabled){
  if(!reuse)statements.push(db.prepare(`INSERT INTO hours_publication_generations(installation_id,activity_id,provider,generation,connection_generation,destination,application_id,marker,created_at) SELECT 'primary',?,?,?,?,?,?,?,? WHERE ${did}`).bind(id,p,gen,c!.generation,c!.destination,c!.applicationId,marker,updatedAt,audit));
  statements.push(db.prepare(`INSERT INTO hours_publication_operations(installation_id,activity_id,provider,generation,action,snapshot_json,actor_user_id,activity_revision,updated_at) SELECT 'primary',?,?,?,'upsert',?,?,?,? WHERE ${did} ON CONFLICT(installation_id,activity_id,provider,generation,action) DO UPDATE SET revision=hours_publication_operations.revision+1,snapshot_json=excluded.snapshot_json,actor_user_id=excluded.actor_user_id,activity_revision=excluded.activity_revision,status=CASE WHEN hours_publication_operations.lease_expires_ms>? THEN 'processing' ELSE 'pending' END,next_attempt_ms=0,last_error=NULL,updated_at=excluded.updated_at`).bind(id,p,gen,content,actor,activityRev,updatedAt,audit,now));
 }
 const result=await db.batch(statements);if(result[0]?.meta?.changes!==1)throw new HttpError(409,'Publication or authority changed; reload');return detail(env,actor,a);
}

function live(o:Row){return `${staffFence} AND ${eventProviderFence(o.provider)} AND EXISTS(SELECT 1 FROM hours_publication_generations g WHERE g.installation_id='primary' AND g.activity_id=? AND g.provider=? AND g.generation=? AND g.abandoned=${o.action==='delete'?1:0})`+(o.action==='upsert'?" AND EXISTS(SELECT 1 FROM hours_publication_intents i JOIN hours_activities a ON a.installation_id=i.installation_id AND a.id=i.activity_id WHERE i.installation_id='primary' AND i.activity_id=? AND i.provider=? AND i.generation=? AND i.enabled=1 AND i.needs_review=0 AND a.archived=0 AND a.revision=?)":'');}
const liveValues=(o:Row,signature:string)=>[o.actor_user_id,signature,o.activity_id,o.provider,o.generation,...(o.action==='upsert'?[o.activity_id,o.provider,o.generation,o.activity_revision]:[])];
export async function publicationModuleEnabled(env:Env){try{await requireModuleEnabled(env.DB!,'primary','hour-tracking');return true;}catch(error){if((error as any)?.status===409)return false;throw error;}}
export async function processHoursPublication(env:Env,p:EventProvider,now=Date.now()){
 const db=env.DB!;if(!await publicationModuleEnabled(env))return {paused:true};
 const o=await db.prepare("SELECT o.*,g.connection_generation,g.destination,g.application_id,g.marker,g.provider_event_id,g.abandoned FROM hours_publication_operations o JOIN hours_publication_generations g USING(installation_id,activity_id,provider,generation) WHERE o.installation_id='primary' AND o.provider=? AND ((o.status IN ('pending','failed') AND o.next_attempt_ms<=?) OR (o.status='processing' AND o.lease_expires_ms<=?)) ORDER BY o.next_attempt_ms,o.updated_at,o.generation,o.action LIMIT 1").bind(p,now,now).first<Row>();if(!o)return {idle:true};
 const token=crypto.randomUUID(),updatedAt=new Date(now).toISOString();let claimed=false;
 try{
  const c=await eventProviderCapability(env,p);if(c.generation!==o.connection_generation||c.destination!==o.destination||c.applicationId!==o.application_id)throw new PublicationReviewError('Old destination requires manual provider review');
  const lease=await db.prepare(`UPDATE hours_publication_operations SET status='processing',lease_token=?,lease_expires_ms=? WHERE ${opKey} AND revision=? AND status IN ('pending','failed','processing') AND (lease_expires_ms IS NULL OR lease_expires_ms<=?) AND ${live(o)}`).bind(token,now+60000,...keys(o),o.revision,now,...liveValues(o,c.signature)).run();if(lease.meta?.changes!==1)throw new PublicationReviewError('Review activity, grant or provider changes');claimed=true;
  const allowed=async()=>{if(!await db.prepare(`SELECT 1 FROM hours_publication_operations WHERE ${opKey} AND revision=? AND lease_token=? AND lease_expires_ms>? AND status='processing' AND ${live(o)}`).bind(...keys(o),o.revision,token,Date.now(),...liveValues(o,c.signature)).first())throw new PublicationReviewError('Publication authority changed during delivery');};
  let remote=await c.find(o.marker,o.provider_event_id);await allowed();
  if(o.action==='delete'){
   if(!remote){const create=await db.prepare(`SELECT phase,lease_expires_ms FROM hours_publication_operations WHERE ${intentWhere} AND generation=? AND action='upsert'`).bind(o.activity_id,p,o.generation).first<Row>();if(create?.phase==='create_dispatched'||(create?.lease_expires_ms??0)>Date.now())throw new PublicationReviewError('An uncertain create needs ownership reconciliation before cleanup');}
   if(remote){await allowed();await c.remove(remote,allowed);}
   await db.prepare(`UPDATE hours_publication_generations SET provider_event_id=NULL WHERE ${intentWhere} AND generation=? AND EXISTS(SELECT 1 FROM hours_publication_operations WHERE ${opKey} AND lease_token=?)`).bind(o.activity_id,p,o.generation,...keys(o),token).run();
  }else{
   const s=JSON.parse(o.snapshot_json) as PublicationSnapshot;
   if(p==='discord'&&Date.parse(s.startsAt!)<=Date.now())throw new PublicationReviewError('Discord publication time passed; review the event');
   if(!remote){
    if(p==='discord'&&o.phase==='create_dispatched')throw new PublicationReviewError('Uncertain Discord create has no unique visible match; review before retrying');
    const mark=await db.prepare(`UPDATE hours_publication_operations SET phase='create_dispatched' WHERE ${opKey} AND lease_token=? AND revision=? AND ${live(o)}`).bind(...keys(o),token,o.revision,...liveValues(o,c.signature)).run();if(mark.meta?.changes!==1)throw new PublicationReviewError('Publication changed before creation');
    await allowed();remote={id:await c.create(o.marker,s,allowed)};
   }else{await allowed();await c.update(o.marker,s,remote,allowed);}
   // Store a late successful ID even when the user disabled/replaced the intent.
   // Its immutable generation/marker remains the cleanup authority; no retarget.
   await db.prepare(`UPDATE hours_publication_generations SET provider_event_id=? WHERE ${intentWhere} AND generation=? AND EXISTS(SELECT 1 FROM hours_publication_operations WHERE ${opKey} AND lease_token=?)`).bind(remote.id,o.activity_id,p,o.generation,...keys(o),token).run();
   await db.prepare(`UPDATE hours_publication_operations SET status='pending',last_error=NULL,next_attempt_ms=0 WHERE ${intentWhere} AND generation=? AND action='delete' AND (lease_expires_ms IS NULL OR lease_expires_ms<=?) AND EXISTS(SELECT 1 FROM hours_publication_generations WHERE ${intentWhere} AND generation=? AND abandoned=1)`).bind(o.activity_id,p,o.generation,Date.now(),o.activity_id,p,o.generation).run();
  }
  await db.prepare(`UPDATE hours_publication_operations SET status=CASE WHEN revision=? AND status='processing' THEN 'complete' WHEN status='review' THEN 'review' ELSE 'pending' END,phase='known',attempts=attempts+1,lease_token=NULL,lease_expires_ms=NULL,last_error=NULL,updated_at=? WHERE ${opKey} AND lease_token=?`).bind(o.revision,new Date().toISOString(),...keys(o),token).run();return {delivered:true};
 }catch(error){
  const review=error instanceof PublicationReviewError||o.attempts>=9,message=review?(error instanceof PublicationReviewError?error.message:'Repeated provider failures need review'):'Provider unavailable; delivery will retry';
  await db.prepare(`UPDATE hours_publication_operations SET status=CASE WHEN revision!=? AND status!='review' THEN 'pending' ELSE ? END,attempts=attempts+1,next_attempt_ms=?,lease_token=NULL,lease_expires_ms=NULL,last_error=CASE WHEN revision!=? THEN NULL ELSE ? END,updated_at=? WHERE ${opKey} AND ${claimed?'lease_token=?':"revision=? AND status IN ('pending','failed','processing') AND (lease_expires_ms IS NULL OR lease_expires_ms<=?)"}`).bind(o.revision,review?'review':'failed',now+Math.min(3600000,1000*2**Math.min(o.attempts,12)),o.revision,message,updatedAt,...keys(o),...(claimed?[token]:[o.revision,now])).run();return {failed:true,review};
 }
}

/** Validate before destructive installation restore, then fence every retained
 * operation requiring provider work. No restored lease authorizes a remote call. */
export function preparePublicationRestore(tables:Record<string,Row[]>){
 const fail=()=>{throw new HttpError(400,'Invalid Hours publication backup');};
 const activities=new Map(tables.hours_activities.map(a=>[a.id,a])),users=new Set(tables.users.map(u=>u.id)),intents=new Map<string,Row>(),generations=new Map<string,Row>(),operations=new Set<string>(),markers=new Set<string>();
 const identity=(r:Row)=>JSON.stringify([r.activity_id,r.provider]),generationKey=(r:Row)=>JSON.stringify([r.activity_id,r.provider,r.generation]);
 const common=(r:Row)=>{if(r.installation_id!=='primary'||!activities.has(r.activity_id)||activities.get(r.activity_id)!.mode!=='event'||!['google','discord'].includes(r.provider))fail();};
 const content=(r:Row)=>{let s:Row;try{s=JSON.parse(r.snapshot_json);}catch{fail();}if(!object(s!))fail();
  if(Object.keys(s!).length){if(typeof s!.serviceDate!=='string'||!/^\d{4}-\d\d-\d\d$/.test(s!.serviceDate)||new Date(s!.serviceDate+'T00:00:00Z').toISOString().slice(0,10)!==s!.serviceDate)fail();
   const validated=snapshot(s!,{service_date:s!.serviceDate,planning_time_zone:s!.timeZone},r.provider,0,true);if(JSON.stringify(validated)!==JSON.stringify(s!))fail();
  }else if(r.enabled||r.action==='upsert')fail();
 };
 for(const r of tables.hours_publication_intents??[]){common(r);const key=identity(r);if(intents.has(key)||!users.has(r.actor_user_id)||![0,1].includes(r.enabled)||![0,1].includes(r.needs_review))fail();integer(r.revision);integer(r.activity_revision);integer(r.generation);if(r.generation>20||r.enabled&&!r.generation)fail();content(r);intents.set(key,r);}
 for(const r of tables.hours_publication_generations??[]){common(r);integer(r.generation);const key=generationKey(r),intent=intents.get(identity(r));if(!intent||r.generation<1||r.generation>intent.generation||generations.has(key)||![0,1].includes(r.abandoned)||!/^[a-f0-9]{32}$/.test(r.marker)||markers.has(r.marker))fail();text(r.connection_generation,128,true);text(r.destination,1024,true);text(r.application_id,24,r.provider==='discord');if(r.provider==='google'&&r.application_id!==''||r.provider==='discord'&&!/^\d{10,24}$/.test(r.application_id))fail();if(r.provider_event_id!==null&&(r.provider==='google'?r.provider_event_id!=='llh'+r.marker:!/^\d{10,24}$/.test(r.provider_event_id)))fail();generations.set(key,r);markers.add(r.marker);}
 for(const r of tables.hours_publication_operations??[]){common(r);const key=generationKey(r)+':'+r.action;if(!generations.has(generationKey(r))||operations.has(key)||!users.has(r.actor_user_id)||!['upsert','delete'].includes(r.action)||!['pending','processing','failed','complete','review'].includes(r.status)||!['ready','create_dispatched','known'].includes(r.phase))fail();integer(r.revision);integer(r.activity_revision);integer(r.attempts);integer(r.next_attempt_ms);if(r.lease_token!==null)text(r.lease_token,128,true);if(r.lease_expires_ms!==null)integer(r.lease_expires_ms);if(r.last_error!==null)text(r.last_error,200);content(r);operations.add(key);}
 for(const r of intents.values())if(r.generation&&!generations.has(generationKey(r)))fail();
 for(const r of generations.values())if(!operations.has(generationKey(r)+':upsert'))fail();
 for(const r of intents.values())if(r.enabled){if(r.revision>=Number.MAX_SAFE_INTEGER-1)fail();r.needs_review=1;r.revision++;}
 for(const r of tables.hours_publication_operations??[]){r.lease_token=null;r.lease_expires_ms=null;if(r.status!=='complete'){r.status='review';r.last_error='Review restored publication and provider ownership';}}
}
