import { documentationAvailable } from '../../../packages/shared/src/release-capabilities.ts';
import {HttpError} from './http-error.ts';
import type {ModuleDatabase} from './platform-modules.ts';
import {documentationBodyHash,readDocumentationProxyBody,verifyDocumentationAssertion,DocumentationProxyError} from '@lancerlogin/shared/documentation-proxy';
import {admitPublicDocumentation,decodePublicDocumentationJson,PublicDocumentationAdmissionError} from './public-documentation-admission.ts';
type Row=Record<string,any>;
const available=`EXISTS(SELECT 1 FROM platform_module_configuration c WHERE c.installation_id=? AND c.hours_enabled=1 AND c.documentation_enabled=1) AND COALESCE((SELECT notes_enabled FROM documentation_sections WHERE installation_id=?),1)=1`;
function fail():never{throw new HttpError(409,'Documentation submission was not accepted. Check the details and current form.');};
const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER;
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max;
const hash=(s:string)=>documentationBodyHash(new TextEncoder().encode(s));
export type DocumentationSubmitter={channel:'public'}|{channel:'discord';discordUserId:string;expectedDiscordIV:string};
/** Adapter-owned identity only. Public JSON cannot supply source, internal member ID or staff authority. */
export async function submitMemberDocumentationNote(db:ModuleDatabase,installation:string,input:unknown,submitter:DocumentationSubmitter={channel:'public'},now=Date.now()){
 if(!documentationAvailable)throw new HttpError(404,'Activity Documentation is unavailable in this release');
 if(!input||typeof input!=='object'||Array.isArray(input))fail();const v=input as Row;
 const allowed=['activityId','activityRevision','sectionRevision','text','idempotencyKey',...(submitter.channel==='public'?['memberId']:[])];
 if(Object.keys(v).some(k=>!allowed.includes(k))||!text(v.activityId,128)||!/^[A-Za-z0-9_-]+$/.test(v.activityId)||!integer(v.activityRevision)||!integer(v.sectionRevision)||!text(v.text,8000)||!v.text.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.text)||!text(v.idempotencyKey,128)||v.idempotencyKey.length<16||submitter.channel==='public'&&(!text(v.memberId,128)||!v.memberId.trim()))fail();
 const key=await hash(v.idempotencyKey),fingerprint=await hash(JSON.stringify([installation,submitter.channel,submitter.channel==='public'?v.memberId:submitter.discordUserId,v.activityId,v.activityRevision,v.sectionRevision,v.text]));
 const replay=async()=>{const r=await db.prepare('SELECT note_id,fingerprint FROM documentation_note_submission_keys WHERE installation_id=? AND channel=? AND key_hash=?').bind(installation,submitter.channel,key).first<Row>();if(!r)return null;if(r.fingerprint!==fingerprint)fail();return {accepted:true,reference:r.note_id};};
 const prior=await replay();if(prior)return prior;
 const member=await db.prepare(`SELECT id FROM members WHERE installation_id=? AND active=1 AND ${submitter.channel==='public'?'external_id':'discord_user_id'}=?`).bind(installation,submitter.channel==='public'?v.memberId:submitter.discordUserId).first<Row>();if(!member)fail();
 const noteId=crypto.randomUUID(),stamp=new Date(now).toISOString(),auditId=crypto.randomUUID();
 const discordFence=submitter.channel==='discord'?` AND EXISTS(SELECT 1 FROM encrypted_integrations WHERE installation_id=? AND provider='discord' AND iv=? AND verified_at IS NOT NULL) AND EXISTS(SELECT 1 FROM installations WHERE id=? AND discord_enabled=1)`:'';
 const statements=[db.prepare(`INSERT INTO documentation_notes(installation_id,id,activity_id,author_member_id,source,text,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ${available} AND COALESCE((SELECT revision FROM documentation_sections WHERE installation_id=?),0)=? AND EXISTS(SELECT 1 FROM hours_activities WHERE installation_id=? AND id=? AND revision=? AND archived=0 AND impact_relevant=1) AND EXISTS(SELECT 1 FROM members WHERE installation_id=? AND id=? AND active=1 AND ${submitter.channel==='public'?'external_id':'discord_user_id'}=?)${discordFence} AND NOT EXISTS(SELECT 1 FROM documentation_note_submission_keys WHERE installation_id=? AND channel=? AND key_hash=?)`).bind(installation,noteId,v.activityId,member.id,submitter.channel,v.text,stamp,stamp,installation,installation,installation,v.sectionRevision,installation,v.activityId,v.activityRevision,installation,member.id,submitter.channel==='public'?v.memberId:submitter.discordUserId,...(submitter.channel==='discord'?[installation,submitter.expectedDiscordIV,installation]:[]),installation,submitter.channel,key),
 db.prepare('INSERT INTO documentation_note_revisions(installation_id,note_id,revision,actor_member_id,source,text,archived,created_at) SELECT installation_id,id,revision,author_member_id,source,text,archived,created_at FROM documentation_notes WHERE installation_id=? AND id=? AND changes()=1').bind(installation,noteId),
 db.prepare("INSERT INTO audit_log(id,installation_id,action,target_type,target_id,created_at) SELECT ?,?,'documentation.note.submitted','documentation',?,? WHERE changes()=1").bind(auditId,installation,noteId,stamp),
 db.prepare('INSERT INTO documentation_note_submission_keys(installation_id,channel,key_hash,fingerprint,note_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_log WHERE id=? AND installation_id=?)').bind(installation,submitter.channel,key,fingerprint,noteId,stamp,auditId,installation)];
 await db.batch(statements);const receipt=await replay();if(!receipt)fail();return receipt;
}
export async function publicDocumentation(request:Request,env:{DB?:ModuleDatabase;SESSION_KEY?:string;ALLOWED_ORIGIN?:string},installation='primary',clock:()=>number=Date.now):Promise<Response>{
 const reply=(body:unknown,status=200,extra:Record<string,string>={})=>Response.json(body,{status,headers:{'cache-control':'no-store',...extra}});
 try{
  const url=new URL(request.url),route=url.pathname.slice('/public/documentation/'.length),write=route==='notes';
  if(!['context','activities','notes'].includes(route))return reply({error:'Documentation route unavailable'},404);
  if(request.method!==(write?'POST':'GET'))return reply({error:'Unsupported Documentation operation'},405);
  if(write&&(!env.ALLOWED_ORIGIN||request.headers.get('origin')!==env.ALLOWED_ORIGIN))return reply({error:'Public submissions require the configured form origin'},403);
  if(!env.DB||!env.SESSION_KEY)throw new HttpError(503,'Documentation is unavailable');const db=env.DB;
  let body:Uint8Array;try{body=await readDocumentationProxyBody(request);}catch(e){await admitPublicDocumentation(db,installation,env.SESSION_KEY,write?'mutation':'read',clock());throw e;}
  const now=clock(),source=env.ALLOWED_ORIGIN?await verifyDocumentationAssertion(request,env.SESSION_KEY,installation,env.ALLOWED_ORIGIN,body,now):null;
  await admitPublicDocumentation(db,installation,env.SESSION_KEY,write?'mutation':'read',now,source);
  const keys:string[]=[];url.searchParams.forEach((_,k)=>keys.push(k));if(new Set(keys).size!==keys.length||keys.some(k=>!(route==='activities'?['after','limit']:[]).includes(k)))throw new HttpError(400,'Invalid Documentation parameters');
  if(write)return reply(await submitMemberDocumentationNote(db,installation,decodePublicDocumentationJson(body),{channel:'public'},clock()),202);
  if(route==='context'){const r=await db.prepare(`SELECT COALESCE((SELECT revision FROM documentation_sections WHERE installation_id=?),0) sectionRevision WHERE ${available}`).bind(installation,installation,installation).first<Row>();return reply(r?{available:true,sectionRevision:r.sectionRevision}:{available:false});}
  const limit=Number(url.searchParams.get('limit')??25),after=url.searchParams.get('after')??'';if(!Number.isInteger(limit)||limit<1||limit>50||after.length>128||after&&!/^[A-Za-z0-9_-]+$/.test(after))throw new HttpError(400,'Invalid Documentation page');
  const row=await db.prepare(`SELECT COALESCE((SELECT revision FROM documentation_sections WHERE installation_id=?),0) sectionRevision,(SELECT json_group_array(json_object('id',id,'title',title,'serviceDate',service_date,'mode',mode,'revision',revision)) FROM (SELECT id,title,service_date,mode,revision FROM hours_activities WHERE installation_id=? AND archived=0 AND impact_relevant=1 AND id>? ORDER BY id LIMIT ?)) items WHERE ${available}`).bind(installation,installation,after,limit+1,installation,installation).first<Row>();if(!row)return reply({error:'Documentation is unavailable'},403);const items=JSON.parse(row.items);return reply({activities:items.slice(0,limit),next:items.length>limit?items[limit-1].id:null,sectionRevision:row.sectionRevision});
 }catch(e){if(e instanceof PublicDocumentationAdmissionError)return reply({error:e.message},e.status,{'retry-after':String(e.retryAfter)});if(e instanceof HttpError||e instanceof DocumentationProxyError)return reply({error:e.message},e.status);return reply({error:'Documentation is temporarily unavailable'},503);}
}
