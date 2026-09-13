import { instantToCivil } from '@lancerlogin/shared/civil-time';
import { HttpError } from './http-error.ts';
import { hoursSelector } from './hours-selectors.ts';
import { requireModuleCapability, type ModuleDatabase } from './platform-modules.ts';
export const hoursColumns = {
 hours_categories: ['installation_id','id','name','mode','impact_default','archived','revision','created_at','updated_at'],
 hours_teams: ['installation_id','id','number','name','organization','program','historical_descriptors','archived','revision','created_at','updated_at'],
 hours_activities: ['installation_id','id','category_id','mode','service_date','team_id','title','description','location','planning_time_zone','starts_at','ends_at','impact_relevant','source_meeting_id','source_snapshot','archived','revision','created_at','updated_at'],
 hours_activity_staff: ['installation_id','activity_id','user_id'], hours_activity_teams: ['installation_id','activity_id','team_id'],
} as const;
export function seedHours(db: ModuleDatabase, installation: string, now: string) {
 return [['event','Event','event'],['team-support','Team Support','team'],['other-service','Other Service','task']].map(([id,name,mode])=>db.prepare('INSERT INTO hours_categories(installation_id,id,name,mode,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(installation,id,name,mode,now,now));
}
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value==='object' && !Array.isArray(value);
const text=(value:unknown,max:number,required=false):string=>{if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new HttpError(400,'Invalid or missing text field');return value.trim();};
const flag=(value:unknown):number=>{if(typeof value!=='boolean')throw new HttpError(400,'Flags must be booleans');return Number(value);};
const date=(value:unknown):string=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new HttpError(400,'Provide a valid service date');return value;};
const instant=(value:unknown):value is string=>typeof value==='string'&&value.length<=40&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)&&Number.isFinite(Date.parse(value))&&date(value.slice(0,10))===value.slice(0,10);
const ids=(value:unknown,max:number):string[]=>{if(!Array.isArray(value)||value.length>max||value.some(id=>typeof id!=='string'||!id.length||id.length>128)||new Set(value).size!==value.length)throw new HttpError(400,'Invalid or duplicate linked identities');return value;};
const revision=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>=Number.MAX_SAFE_INTEGER)throw new HttpError(400,'Provide the current revision');return Number(value);};
const camel=(key:string)=>key.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase());
// Staff-only serialization. Future public submissions/docs require their own narrow allowlist.
function staffRow(row: Row) { const result: Row={}; for(const [key,value] of Object.entries(row))if(key!=='installation_id')result[camel(key)]=['archived','impact_default','impact_relevant'].includes(key)?Boolean(value):value; if(typeof result.sourceSnapshot==='string')result.sourceSnapshot=JSON.parse(result.sourceSnapshot); return result; }
const canWrite=`EXISTS(SELECT 1 FROM users u JOIN platform_module_configuration c ON c.installation_id=u.installation_id LEFT JOIN platform_module_grants g ON g.installation_id=u.installation_id AND g.user_id=u.id WHERE u.installation_id=? AND u.id=? AND u.active=1 AND c.hours_enabled=1 AND (u.role='admin' OR g.hours_manage=1))`;
const tableFor={categories:'hours_categories',teams:'hours_teams',activities:'hours_activities'} as const;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function localDate(instant:string,zone:string){try{return instantToCivil(Date.parse(instant),zone).date;}catch{throw new HttpError(400,'Planning date or time zone is invalid');}}
function planningZone(value:unknown):string { const zone=text(value,100,true);try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{throw new HttpError(400,'Invalid planning time zone');}return zone; }
function validatePlanning(row:Row) {
 const zone=planningZone(row.planning_time_zone);
 if((row.starts_at===null)!==(row.ends_at===null))throw new HttpError(400,'Provide both planning times or neither');
 if(row.starts_at!==null&&(!instant(row.starts_at)||!instant(row.ends_at)||Date.parse(row.ends_at)<=Date.parse(row.starts_at)||localDate(row.starts_at,zone)!==row.service_date||localDate(new Date(Date.parse(row.ends_at)-1).toISOString(),zone)!==row.service_date))throw new HttpError(400,'Planning times must fit the single activity date in its saved time zone');
}
async function activityDetail(db:ModuleDatabase,installation:string,row:Row) {
 const result=staffRow(row);
 const [staff,teams]=await Promise.all([db.prepare('SELECT user_id FROM hours_activity_staff WHERE installation_id=? AND activity_id=? ORDER BY user_id').bind(installation,row.id).all<Row>(),db.prepare('SELECT team_id FROM hours_activity_teams WHERE installation_id=? AND activity_id=? ORDER BY team_id').bind(installation,row.id).all<Row>()]);
 result.responsibleStaffIds=(staff.results??[]).map(r=>r.user_id);result.partnerTeamIds=(teams.results??[]).map(r=>r.team_id);
 if(row.source_meeting_id){const source=await db.prepare('SELECT title,starts_at,ends_at,deleted_at FROM meetings WHERE installation_id=? AND id=?').bind(installation,row.source_meeting_id).first<Row>();const snapshot=result.sourceSnapshot as Row;result.sourceState=!source||source.deleted_at?'unavailable':source.title===snapshot.title&&source.starts_at===snapshot.startsAt&&source.ends_at===snapshot.endsAt?'current':'changed';}
 return result;
}
export async function hoursCatalogRoute(db:ModuleDatabase,installation:string,actor:string,request:Request,input?:unknown):Promise<{status:number;body:unknown}> {
 await requireModuleCapability(db,installation,actor,'hours.manage');
 const selection=await hoursSelector(db,installation,new URL(request.url),request.method);if(selection!==undefined)return {status:200,body:selection};
 const url=new URL(request.url), match=/^\/admin\/hours\/(categories|teams|activities)(?:\/([^/]+))?$/.exec(url.pathname);
 if(!match)throw new HttpError(404,'Hour Tracking route not found');
 const kind=match[1] as keyof typeof tableFor,table=tableFor[kind],id=match[2]?decodeURIComponent(match[2]):undefined;
 if(id&&(!id.length||id.length>128))throw new HttpError(400,'Invalid record identity');
 if(request.method==='GET'){
  if(id){const row=await db.prepare(`SELECT * FROM ${table} WHERE installation_id=? AND id=?`).bind(installation,id).first<Row>();if(!row)throw new HttpError(404,'Hour Tracking record not found');return {status:200,body:kind==='activities'?await activityDetail(db,installation,row):staffRow(row)};}
  const allowed=['limit','after','archived',...(kind==='activities'?['from','to','mode','categoryId','teamId']:[])];url.searchParams.forEach((_,key)=>{if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpError(400,'Invalid catalog filter');});
  const limit=Number(url.searchParams.get('limit')??50);if(!Number.isInteger(limit)||limit<1||limit>100)throw new HttpError(400,'Limit must be from 1 to 100');
  const after=url.searchParams.get('after')??'';if(after.length>128)throw new HttpError(400,'Invalid pagination cursor');
  const archived=url.searchParams.get('archived')??'false';if(!['false','true','all'].includes(archived))throw new HttpError(400,'Invalid archive filter');
  const clauses=['installation_id=?','id>?'],values:unknown[]=[installation,after];if(archived!=='all'){clauses.push('archived=?');values.push(Number(archived==='true'));}
  for(const [parameter,column] of [['from','service_date >='],['to','service_date <='],['mode','mode ='],['categoryId','category_id ='],['teamId','team_id =']]){const value=url.searchParams.get(parameter);if(value!==null){if(parameter==='from'||parameter==='to')date(value);else if(parameter==='mode'&&!['event','team','task'].includes(value))throw new HttpError(400,'Invalid mode');else text(value,128,true);clauses.push(`${column} ?`);values.push(value);}}
  const rows=(await db.prepare(`SELECT * FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`).bind(...values,limit+1).all<Row>()).results??[];
  return {status:200,body:{items:rows.slice(0,limit).map(staffRow),nextCursor:rows.length>limit?rows[limit-1].id:null}};
 }
 if(!['POST','PATCH'].includes(request.method)||((request.method==='POST')===Boolean(id)))throw new HttpError(405,'Use POST to create or PATCH with a record identity');
 if(!object(input))throw new HttpError(400,'Provide a JSON object');
 const existing=id?await db.prepare(`SELECT * FROM ${table} WHERE installation_id=? AND id=?`).bind(installation,id).first<Row>():null;if(id&&!existing)throw new HttpError(404,'Hour Tracking record not found');
 const current=existing?staffRow(existing):{},next={...current,...input},now=new Date().toISOString(),target=id??crypto.randomUUID();
 const common=['revision','archived'];const fields=kind==='categories'?['name','mode','impactDefault']:kind==='teams'?['number','name','organization','program','historicalDescriptors']:['categoryId','serviceDate','teamId','title','description','location','startsAt','endsAt','impactRelevant','sourceMeetingId','expectedTimeZone','responsibleStaffIds','partnerTeamIds'];
 if(Object.keys(input).some(key=>![...common,...fields].includes(key)))throw new HttpError(400,'Unknown catalog field');
 if(!id&&'revision'in input)throw new HttpError(400,'New records do not take a revision');
 const expected=id?revision(input.revision):0;const row:Row={archived:flag(next.archived??false)};let extra='',extraValues:unknown[]=[];let staff:string[]=[],partners:string[]=[];
 if(kind==='categories'){
  row.name=text(next.name,100,true);row.mode=text(next.mode,10,true);if(!['event','team','task'].includes(String(row.mode)))throw new HttpError(400,'Invalid category mode');row.impact_default=flag(next.impactDefault??false);
  if(id){extra=' AND NOT EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND category_id=? AND mode!=?)';extraValues=[installation,id,row.mode];}
 }else if(kind==='teams'){
  row.name=text(next.name,150,true);row.number=text(next.number??'',32);row.organization=text(next.organization??'',200);row.program=text(next.program??'',100);row.historical_descriptors=text(next.historicalDescriptors??'',4000);
 }else{
  const categoryId=text(next.categoryId,128,true),category=await db.prepare('SELECT * FROM hours_categories WHERE installation_id=? AND id=?').bind(installation,categoryId).first<Row>();
  if(!category||(!id&&category.archived))throw new HttpError(400,'Select an active category');
  row.category_id=categoryId;row.mode=category.mode;
  if(id&&categoryId!==existing!.category_id)throw new HttpError(400,'Activity category identity cannot change');
  row.team_id=next.teamId==null?null:text(next.teamId,128,true);
  if((row.team_id!==null&&typeof row.team_id!=='string')||(row.mode==='team')!==Boolean(row.team_id))throw new HttpError(400,'Team mode requires a supported team; other modes do not take one');
  if(id&&row.team_id!==existing!.team_id)throw new HttpError(400,'Activity team identity cannot change');
  let source:Row|null=null;
  if(!id&&next.sourceMeetingId!=null){if(row.mode!=='event')throw new HttpError(400,'Only event activities can link attendance');const sourceId=text(next.sourceMeetingId,128,true);source=await db.prepare('SELECT id,title,starts_at,ends_at FROM meetings WHERE installation_id=? AND id=? AND deleted_at IS NULL AND is_test=0').bind(installation,sourceId).first<Row>();if(!source)throw new HttpError(404,'Attendance planning reference is unavailable');}
  if(id&&'sourceMeetingId'in input&&input.sourceMeetingId!==existing!.source_meeting_id)throw new HttpError(400,'Attendance source is a creation-time reference');
  const zone=existing?planningZone(existing.planning_time_zone):(await db.prepare('SELECT time_zone FROM organization_settings WHERE installation_id=?').bind(installation).first<{time_zone:string}>())?.time_zone??'UTC';
  if ('expectedTimeZone' in input) { if (id) throw new HttpError(400,'Planning zone precondition applies only to creation'); if (planningZone(input.expectedTimeZone)!==zone) throw new HttpError(409,'Organization planning zone changed; reload before retrying'); }
  row.planning_time_zone=zone;
  row.service_date=date(next.serviceDate??(source?localDate(String(source.starts_at),zone):undefined));
  if(id&&row.mode!=='event'&&row.service_date!==existing!.service_date)throw new HttpError(400,'Dated support activity identity cannot change');
  row.title=text(next.title??source?.title??`${category.name} — ${row.service_date}`,150,true);row.description=text(next.description??'',4000);row.location=text(next.location??'',300);
  row.starts_at=next.startsAt===undefined?source?.starts_at??null:next.startsAt;row.ends_at=next.endsAt===undefined?source?.ends_at??null:next.endsAt;
  validatePlanning(row);
  row.impact_relevant=flag(next.impactRelevant??Boolean(category.impact_default));
  row.source_meeting_id=existing?.source_meeting_id??source?.id??null;row.source_snapshot=existing?.source_snapshot??(source?JSON.stringify({title:source.title,startsAt:source.starts_at,endsAt:source.ends_at,serviceDate:localDate(String(source.starts_at),zone)}):null);
  const detail=existing?await activityDetail(db,installation,existing):{};
  staff=ids(next.responsibleStaffIds??detail.responsibleStaffIds??[],10);partners=ids(next.partnerTeamIds??detail.partnerTeamIds??[],20);
  extra=` AND EXISTS(SELECT 1 FROM hours_categories WHERE installation_id=? AND id=? AND revision=? ${id?'':'AND archived=0'}) AND (? IS NULL OR EXISTS(SELECT 1 FROM hours_teams WHERE installation_id=? AND id=? ${id?'':'AND archived=0'}))
   AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN users u ON u.installation_id=? AND u.id=j.value WHERE u.id IS NULL OR (u.active!=1 AND NOT EXISTS(SELECT 1 FROM hours_activity_staff WHERE installation_id=? AND activity_id=? AND user_id=j.value)))
   AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN hours_teams t ON t.installation_id=? AND t.id=j.value WHERE t.id IS NULL OR (t.archived=1 AND NOT EXISTS(SELECT 1 FROM hours_activity_teams WHERE installation_id=? AND activity_id=? AND team_id=j.value)))`;
  extraValues=[installation,categoryId,category.revision,row.team_id,installation,row.team_id,JSON.stringify(staff),installation,installation,target,JSON.stringify(partners),installation,installation,target];
  if (!id) { extra+=" AND COALESCE((SELECT time_zone FROM organization_settings WHERE installation_id=?),'UTC')=?"; extraValues.push(installation,zone); }
 }
 const columns=Object.keys(row),values=Object.values(row),auditId=crypto.randomUUID();
 const write=id?db.prepare(`UPDATE ${table} SET ${columns.map(column=>column+'=?').join(',')},revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=? AND ${canWrite}${extra}`).bind(...values,now,installation,id,expected,installation,actor,...extraValues):db.prepare(`INSERT INTO ${table}(installation_id,id,${columns.join(',')},revision,created_at,updated_at) SELECT ?,?,${columns.map(()=>'?').join(',')},0,?,? WHERE ${canWrite}${extra}`).bind(installation,target,...values,now,now,installation,actor,...extraValues);
 const statements=[write,db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,?,?,'hours_catalog',?,?,? WHERE changes()=1").bind(auditId,installation,actor,`hours.${kind}.${id?'updated':'created'}`,target,JSON.stringify({revision:id?expected+1:0,archived:Boolean(row.archived)}),now)];
 if(kind==='activities')for(const [link,column,values] of [['hours_activity_staff','user_id',staff],['hours_activity_teams','team_id',partners]] as const){const gate='EXISTS(SELECT 1 FROM audit_log WHERE id=?)';statements.push(db.prepare(`DELETE FROM ${link} WHERE installation_id=? AND activity_id=? AND ${gate}`).bind(installation,target,auditId));statements.push(db.prepare(`INSERT INTO ${link}(installation_id,activity_id,${column}) SELECT ?,?,value FROM json_each(?) WHERE ${gate}`).bind(installation,target,JSON.stringify(values),auditId));}
 let results;try{results=await db.batch(statements);}catch(error){if(String(error).includes('hours_activity_date_history'))throw new HttpError(409,'This activity has hour history. Keep its service date; create a separate dated activity instead.');if(/UNIQUE|FOREIGN KEY|CHECK constraint/i.test(String(error)))throw new HttpError(409,'Catalog identity or references conflict; reload before retrying');throw error;}
 // D1 metadata includes publication-trigger writes; the conditional audit records only this request's direct mutation.
 if(results[1]?.meta?.changes!==1)throw new HttpError(409,'Record, references, or module access changed; reload before retrying');
 return {status:id?200:201,body:{id:target,revision:id?expected+1:0}};
}
export function validateHoursBackup(tables:Record<string,Row[]>) {
 const maps:Record<string,Map<string,Row>>={};
 for(const table of ['hours_categories','hours_teams','hours_activities']){
  const rows=tables[table]??[],seen=new Map<string,Row>();maps[table]=seen;
  for(const row of rows){if(row.installation_id!=='primary'||typeof row.id!=='string'||!row.id.length||row.id.length>128||seen.has(row.id)||![0,1].includes(row.archived as number))throw new HttpError(400,'Invalid Hour Tracking backup identity');revision(row.revision);text(row.created_at,40,true);text(row.updated_at,40,true);seen.set(row.id,row);
   if(table==='hours_categories'){text(row.name,100,true);if(!['event','team','task'].includes(String(row.mode))||![0,1].includes(row.impact_default as number))throw new HttpError(400,'Invalid category backup');}
   if(table==='hours_teams'){text(row.name,150,true);text(row.number,32);text(row.organization,200);text(row.program,100);text(row.historical_descriptors,4000);}
  }
 }
 const groups=new Set<string>();
 for(const row of maps.hours_activities.values()){
  const category=typeof row.category_id==='string'?maps.hours_categories.get(row.category_id):undefined;if(!category||category.mode!==row.mode||![0,1].includes(row.impact_relevant as number))throw new HttpError(400,'Invalid activity category or relevance');
  date(row.service_date);text(row.title,150,true);text(row.description,4000);text(row.location,300);
  if((row.team_id!==null&&typeof row.team_id!=='string')||(row.mode==='team')!==Boolean(row.team_id)||(row.team_id&&!maps.hours_teams.has(String(row.team_id))))throw new HttpError(400,'Invalid supported team reference');
  if(row.mode!=='event'){const group=JSON.stringify([row.category_id,row.service_date,row.team_id]);if(groups.has(group))throw new HttpError(400,'Duplicate dated activity identity');groups.add(group);}
  validatePlanning(row);
  if(row.source_meeting_id===null){if(row.source_snapshot!==null)throw new HttpError(400,'Invalid attendance snapshot');}
  else{if(row.mode!=='event')throw new HttpError(400,'Invalid attendance snapshot mode');text(row.source_meeting_id,128,true);let source;try{source=JSON.parse(String(row.source_snapshot));}catch{throw new HttpError(400,'Invalid attendance snapshot');}if(!object(source)||!same(Object.keys(source).sort(),['endsAt','serviceDate','startsAt','title']))throw new HttpError(400,'Invalid attendance snapshot fields');text(source.title,150,true);date(source.serviceDate);if(!instant(source.startsAt)||!instant(source.endsAt)||Date.parse(source.endsAt)<=Date.parse(source.startsAt))throw new HttpError(400,'Invalid attendance snapshot times');}
 }
 for(const [table,column,targets,max] of [['hours_activity_staff','user_id',new Map((tables.users??[]).filter(row=>row.installation_id==='primary').map(row=>[String(row.id),row])),10],['hours_activity_teams','team_id',maps.hours_teams,20]] as const){const seen=new Set<string>(),counts=new Map<string,number>();for(const row of tables[table]??[]){const activity=String(row.activity_id),target=String(row[column]),key=JSON.stringify([activity,target]);if(typeof row.activity_id!=='string'||typeof row[column]!=='string'||row.installation_id!=='primary'||!maps.hours_activities.has(activity)||!targets.has(target)||seen.has(key))throw new HttpError(400,'Invalid activity links');seen.add(key);counts.set(activity,(counts.get(activity)??0)+1);if(counts.get(activity)!>max)throw new HttpError(400,'Too many activity links');}}
}
