import { providerFetch } from './maintenance.ts';
import type {Env} from './index.ts';
import {HttpError} from './http-error.ts';
import {googleCapability,googleConnectionRow,readGoogleBody} from './google-connection.ts';
import {discordReadDeadline} from './discord-platform.ts';
import {editPrivateInteraction} from './discord-interaction-reply.ts';
import {pickerInput} from './google-drive-picker.ts';
import {attachmentFixtures} from './discord-attachment-fixtures.ts';
export const attachmentDevelopmentOrigin='https://lancerlogin-v2-example-dashboard.pages.dev';
const snow=(v:unknown):v is string=>typeof v==='string'&&/^\d{10,24}$/.test(v);
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
class AttachmentDeadline extends HttpError {constructor(){super(409,'Attachment download expired');}}
function fail():never{throw new HttpError(409,'Synthetic attachment proof unavailable; use the provided PNG/PDF fixtures and ask the coordinator to inspect the operation.');}
const reply=(content:string)=>Response.json({type:4,data:{content,flags:64,allowed_mentions:{parse:[]}}});

const diagnosticStages=['started','shape','selection','resolved','filename','mime','size','url','authority','cdn_fetch','cdn_status','cdn_body','fixture_hash','google_access','root','permissions','allocate','pending_write','upload','verify','saved_write','complete'] as const;
type DiagnosticStage=typeof diagnosticStages[number];
type Mark=(stage:DiagnosticStage)=>void;
const noop:Mark=()=>{};
export function attachmentDiagnostic(value:unknown){
 if(!object(value)||Object.keys(value).length!==2||!diagnosticStages.includes(value.stage)||!['started','failed','deadline_elapsed','complete'].includes(value.category))return null;
 if((value.stage==='started')!==(value.category==='started')||(value.stage==='complete')!==(value.category==='complete'))return null;
 return {stage:value.stage as DiagnosticStage,category:value.category as string};
}
async function recordDiagnostic(env:Env,row:Row,submitId:string,stage:DiagnosticStage,category:string){
 const diagnostic=attachmentDiagnostic({stage,category});if(!diagnostic)return;
 await env.DB!.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,'primary',NULL,'discord.attachment.diagnostic','synthetic_attachment_proof',?,?,? WHERE EXISTS(SELECT 1 FROM discord_attachment_proofs WHERE installation_id='primary' AND id=? AND submit_id=? AND provider_iv=?) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json WHERE audit_log.action='discord.attachment.diagnostic' AND audit_log.target_id=excluded.target_id AND audit_log.actor_user_id IS NULL").bind('attachment-diagnostic:'+row.id,row.id,JSON.stringify(diagnostic),new Date().toISOString(),row.id,submitId,row.provider_iv).run();
}
async function diagnosticSummary(env:Env,row:Row){
 const result=await env.DB!.prepare("SELECT metadata_json FROM audit_log WHERE installation_id='primary' AND id=? AND action='discord.attachment.diagnostic' AND target_id=? AND actor_user_id IS NULL").bind('attachment-diagnostic:'+row.id,row.id).first<{metadata_json:string}>();
 let diagnostic=null;try{if(result&&result.metadata_json.length<=200)diagnostic=attachmentDiagnostic(JSON.parse(result.metadata_json));}catch{}
 return {...summary(row),diagnostic};
}

type Row={id:string;member_id:string;discord_user_id:string;provider_iv:string;generation:string;google_iv:string;root_id:string;root_revision:number;status:string;submit_id:string|null;expires_at:number;busy_until:number;file_id:string|null;mime:string|null;byte_size:number|null;sha256:string|null};
const authority=`EXISTS(SELECT 1 FROM installations x JOIN encrypted_integrations d ON d.installation_id=x.id WHERE x.id='primary' AND x.discord_enabled=1 AND d.provider='discord' AND d.verified_at IS NOT NULL AND d.iv=discord_attachment_proofs.provider_iv)
 AND EXISTS(SELECT 1 FROM members m WHERE m.installation_id='primary' AND m.id=discord_attachment_proofs.member_id AND m.discord_user_id=discord_attachment_proofs.discord_user_id AND m.active=1)
 AND EXISTS(SELECT 1 FROM google_connections g WHERE g.installation_id='primary' AND g.active_iv=discord_attachment_proofs.google_iv AND g.grant_error IS NOT 'revoked')
 AND EXISTS(SELECT 1 FROM google_drive_feasibility f WHERE f.installation_id='primary' AND f.root_id=discord_attachment_proofs.root_id AND f.revision=discord_attachment_proofs.root_revision AND f.generation=discord_attachment_proofs.generation)`;
async function current(env:Env,row:Row,deadline:number){
 if(env.ALLOWED_ORIGIN!==attachmentDevelopmentOrigin||Date.now()>=deadline)fail();
 const found=await env.DB!.prepare(`SELECT id FROM discord_attachment_proofs WHERE installation_id='primary' AND id=? AND ${authority}`).bind(row.id).first();if(!found)fail();
}
export function discordAttachmentUrl(value:unknown,id:string,now=Date.now()){
 if(typeof value!=='string'||value.length>2048||!value.startsWith('https://cdn.discordapp.com/')||!snow(id))fail();const u=new URL(value);
 if(u.protocol!=='https:'||u.hostname!=='cdn.discordapp.com'||u.port||u.username||u.password||u.hash||!new RegExp('^/attachments/[0-9]{10,24}/'+id+'/[^/]+$').test(u.pathname)||/%(?:2f|5c|00)|\\|\.\./i.test(u.pathname))fail();
 const params:string[]=[];u.searchParams.forEach((_,k)=>params.push(k));if(params.some(k=>!['ex','is','hm'].includes(k))||params.length!==3||!/^[a-f0-9]{64}$/i.test(u.searchParams.get('hm')??''))fail();
 const ex=u.searchParams.get('ex')??'',issued=u.searchParams.get('is')??'';if(!/^[a-f0-9]{1,12}$/i.test(ex)||!/^[a-f0-9]{1,12}$/i.test(issued))fail();
 const end=parseInt(ex,16)*1000,start=parseInt(issued,16)*1000;if(!Number.isSafeInteger(end)||end<=now+1000||start>now+60000||start>=end)fail();return u.href;
}
export async function attachmentBytes(response:Response,expected:number,deadline:number){
 if(!response.ok||!response.body||!Number.isSafeInteger(expected)||expected<1||expected>1048576)fail();
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==expected))fail();
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let total=0,timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AttachmentDeadline()),Math.max(1,deadline-Date.now()));});
 try{for(;;){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;total+=value.length;if(total>expected||total>1048576)fail();parts.push(value);}}catch(e){void reader.cancel().catch(()=>{});throw e;}finally{clearTimeout(timer);reader.releaseLock();}
 if(total!==expected||Date.now()>=deadline)fail();const bytes=new Uint8Array(total);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return bytes;
}
const hash=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes).buffer)),x=>x.toString(16).padStart(2,'0')).join('');
export async function validateAttachmentFixture(bytes:Uint8Array,mime:string){const digest=await hash(bytes),fixture=attachmentFixtures.find(f=>f.mime===mime&&f.size===bytes.length&&f.sha256===digest);if(!fixture)fail();return fixture;}
function selected(data:unknown,mark:Mark=noop){
 mark('shape');
 if(!object(data)||!Array.isArray(data.components)||data.components.length!==1)fail();const label=data.components[0],upload=label?.component;
 mark('selection');if(label?.type!==18||upload?.type!==19||upload.custom_id!=='fixture'||!Array.isArray(upload.values)||upload.values.length!==1||!snow(upload.values[0]))fail();
 mark('resolved');const id=upload.values[0],attachments=data.resolved?.attachments;if(!object(attachments)||Object.keys(attachments).length!==1||!object(attachments[id]))fail();const a=attachments[id];
 if(a.id!==id)fail();mark('filename');if(typeof a.filename!=='string'||a.filename.length<1||a.filename.length>255)fail();mark('mime');if(!attachmentFixtures.some(f=>f.mime===a.content_type))fail();mark('size');if(!Number.isSafeInteger(a.size)||a.size<1||a.size>1048576||!attachmentFixtures.some(f=>f.mime===a.content_type&&f.size===a.size))fail();
 mark('url');
 return {url:discordAttachmentUrl(a.url,id),size:a.size as number,mime:a.content_type as string};
}
function summary(row:Row){return {id:row.id,status:row.status,fileId:row.file_id,size:row.byte_size,sha256:row.sha256,mime:row.mime};}
async function drive(env:Env,row:Row,deadline:number,actor?:{userId:string;expiresAt:number},mark:Mark=noop){
 mark('authority');await current(env,row,deadline);mark('google_access');const cap=await googleCapability(env,'drive');if(cap.signature!==row.google_iv||cap.generation!==row.generation)fail();const token=await cap.accessToken();await current(env,row,deadline);
 const request=async(url:string,init:RequestInit={})=>{await current(env,row,deadline);const response=await providerFetch(env)(url,{...init,headers:{...init.headers,authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(6000,deadline-Date.now())))});if(!response.ok)fail();return await readGoogleBody(response);};
 const base='https://www.googleapis.com/drive/v3/files';
 const privatePermissions=async(id:string)=>{mark('permissions');const p=await request(base+'/'+id+'/permissions?fields=permissions(type,role),nextPageToken&pageSize=100');if(!Array.isArray(p.permissions)||p.permissions.length!==1||p.nextPageToken||p.permissions[0]?.type!=='user'||p.permissions[0]?.role!=='owner')fail();};
 const root=async()=>{mark('root');const f=await request(base+'/'+row.root_id+'?fields=id,mimeType,trashed,ownedByMe,capabilities(canAddChildren)');if(f.id!==row.root_id||f.mimeType!=='application/vnd.google-apps.folder'||f.trashed!==false||f.ownedByMe!==true||(f.capabilities as any)?.canAddChildren!==true)fail();await privatePermissions(row.root_id);};
 const verify=async()=>{if(!row.file_id)fail();await root();mark('verify');const f=await request(base+'/'+row.file_id+'?fields=id,mimeType,parents,trashed,ownedByMe,size,sha256Checksum,appProperties');if(f.id!==row.file_id||f.mimeType!==row.mime||f.trashed!==false||f.ownedByMe!==true||Number(f.size)!==row.byte_size||f.sha256Checksum!==row.sha256||!Array.isArray(f.parents)||f.parents.length!==1||f.parents[0]!==row.root_id||(f.appProperties as any)?.lancerloginAttachmentProof!==row.id)fail();await privatePermissions(row.file_id!);await current(env,row,deadline);
 mark('saved_write');const saved=await env.DB!.prepare(`UPDATE discord_attachment_proofs SET status='saved',busy_until=0 WHERE installation_id='primary' AND id=? AND status='pending' AND ${authority} AND (? IS NULL OR EXISTS(SELECT 1 FROM users WHERE installation_id='primary' AND id=? AND active=1 AND role='admin') AND ?>CAST(unixepoch('subsec')*1000 AS INTEGER))`).bind(row.id,actor?.userId??null,actor?.userId??null,actor?.expiresAt??0).run();if(saved.meta?.changes!==1)fail();row.status='saved';};
 return {request,root,verify,base};
}
async function process(env:Env,row:Row,data:unknown,submitId:string){
 const deadline=Date.now()+25000;
 const claimed=await env.DB!.prepare(`UPDATE discord_attachment_proofs SET status='processing',submit_id=?,busy_until=? WHERE installation_id='primary' AND id=? AND status='modal' AND expires_at>? AND ${authority}`).bind(submitId,deadline,row.id,Date.now()).run();
 if(claimed.meta?.changes!==1)return;row.status='processing';
 let stage:DiagnosticStage='started';const mark:Mark=value=>{stage=value;};
 try{
  try{await recordDiagnostic(env,row,submitId,'started','started');}catch{/* Best-effort evidence only. */}
  const source=selected(data,mark);mark('authority');await current(env,row,deadline);mark('cdn_fetch');const response=await providerFetch(env)(source.url,{redirect:'manual',signal:AbortSignal.timeout(6000)});
  mark('cdn_status');if(!response.ok)fail();mark('cdn_body');const bytes=await attachmentBytes(response,source.size,Math.min(deadline,Date.now()+6000));mark('fixture_hash');const fixture=await validateAttachmentFixture(bytes,source.mime);
  const client=await drive(env,row,deadline,undefined,mark);await client.root();mark('allocate');const allocated=await client.request(client.base+'/generateIds?count=1&space=drive&type=files');
  if(!Array.isArray(allocated.ids)||allocated.ids.length!==1||typeof allocated.ids[0]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(allocated.ids[0]))fail();
  row.file_id=allocated.ids[0];row.mime=fixture.mime;row.sha256=fixture.sha256;row.byte_size=fixture.size;
  mark('pending_write');const pending=await env.DB!.prepare(`UPDATE discord_attachment_proofs SET status='pending',file_id=?,mime=?,byte_size=?,sha256=? WHERE installation_id='primary' AND id=? AND status='processing' AND submit_id=? AND busy_until>? AND ${authority}`).bind(row.file_id,row.mime,row.byte_size,row.sha256,row.id,submitId,Date.now()).run();if(pending.meta?.changes!==1)fail();row.status='pending';
  // Preallocated ID + durable pending receipt; never issue this POST again.
  const boundary='lancerlogin-'+row.id;const metadata=JSON.stringify({id:row.file_id,name:fixture.name,mimeType:fixture.mime,parents:[row.root_id],appProperties:{lancerloginAttachmentProof:row.id}});
  const body=new Blob(['--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+metadata+'\r\n--'+boundary+'\r\nContent-Type: '+fixture.mime+'\r\n\r\n',Uint8Array.from(bytes).buffer,'\r\n--'+boundary+'--\r\n']);
  mark('upload');await client.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',headers:{'content-type':'multipart/related; boundary='+boundary},body});await client.verify();try{await recordDiagnostic(env,row,submitId,'complete','complete');}catch{/* Saved outcome remains authoritative. */}
 }catch(error){try{await recordDiagnostic(env,row,submitId,stage,Date.now()>=deadline||error instanceof AttachmentDeadline||error instanceof DOMException&&error.name==='TimeoutError'?'deadline_elapsed':'failed');}catch{/* Diagnostics never alter transfer outcomes. */}if(row.status==='processing')await env.DB!.prepare("UPDATE discord_attachment_proofs SET status='failed' WHERE installation_id='primary' AND id=? AND status='processing'").bind(row.id).run();}
 finally{await env.DB!.prepare("UPDATE discord_attachment_proofs SET busy_until=0 WHERE installation_id='primary' AND id=?").bind(row.id).run();}
}
export function isAttachmentProof(interaction:any){return interaction?.data?.name==='attachment-proof'||typeof interaction?.data?.custom_id==='string'&&interaction.data.custom_id.startsWith('llap:');}
export async function attachmentInteraction(env:Env,interaction:any,config:Record<string,string>,providerIv:string,execution:{waitUntil(p:Promise<unknown>):void}|undefined,receivedAt:number){
 if(env.ALLOWED_ORIGIN!==attachmentDevelopmentOrigin||!execution||interaction.application_id!==config.applicationId||interaction.guild_id!==config.guildId||!snow(interaction.member?.user?.id)||!snow(interaction.id)||typeof interaction.token!=='string'||!/^[A-Za-z0-9._-]{1,2048}$/.test(interaction.token))return reply('Synthetic attachment proof is unavailable.');
 const user=interaction.member.user.id;
 if(interaction.type===2&&interaction.data.name==='attachment-proof'){
  try{return await discordReadDeadline((async()=>{
   if(interaction.data.options!==undefined&&(!Array.isArray(interaction.data.options)||interaction.data.options.length))fail();
   const member=await env.DB!.prepare("SELECT id FROM members WHERE installation_id='primary' AND discord_user_id=? AND active=1").bind(user).first<{id:string}>();if(!member)fail();
   const cap=await googleCapability(env,'drive'),root=await env.DB!.prepare("SELECT * FROM google_drive_feasibility WHERE installation_id='primary'").first<any>();if(!root?.root_id||root.generation!==cap.generation||!/^[A-Za-z0-9_-]{1,128}$/.test(root.root_id))fail();
   const id=crypto.randomUUID();const inserted=await env.DB!.prepare("INSERT INTO discord_attachment_proofs(installation_id,id,member_id,discord_user_id,provider_iv,generation,google_iv,root_id,root_revision,status,expires_at) SELECT 'primary',?,?,?,?,?,?,?,?,'modal',? WHERE (SELECT COUNT(*) FROM discord_attachment_proofs)<16").bind(id,member.id,user,providerIv,cap.generation,cap.signature,root.root_id,root.revision,Date.now()+300000).run();if(inserted.meta?.changes!==1)fail();
   return Response.json({type:9,data:{custom_id:'llap:'+id,title:'Synthetic attachment transfer',components:[{type:18,label:'Use the provided synthetic PNG or PDF only',component:{type:19,custom_id:'fixture',min_values:1,max_values:1,required:true,file_types:['.png','.pdf']}}]}});
  })(),receivedAt+2500);}catch{return reply('Pair first and ask the coordinator to prepare the private Drive root and synthetic fixtures.');}
 }
 if(interaction.type!==5||!/^llap:[a-f0-9-]{36}$/.test(interaction.data?.custom_id??''))return reply('This synthetic modal is invalid.');
 execution.waitUntil((async()=>{let message='Proof not saved; coordinator review is required.';try{
  const row=await env.DB!.prepare("SELECT * FROM discord_attachment_proofs WHERE installation_id='primary' AND id=? AND discord_user_id=? AND provider_iv=?").bind(interaction.data.custom_id.slice(5),user,providerIv).first<Row>();if(!row)fail();await process(env,row,interaction.data,interaction.id);
  const result=await env.DB!.prepare('SELECT status FROM discord_attachment_proofs WHERE installation_id=\'primary\' AND id=?').bind(row.id).first<{status:string}>();message=result?.status==='saved'?'Synthetic fixture saved privately and verified. Proof '+row.id:'Proof '+row.id+' is not confirmed saved. Use the provided fixtures; coordinator readback is required.';
 }catch{}try{await editPrivateInteraction(config.applicationId,interaction.token,{content:message},receivedAt+14*60000, undefined, env);}catch{/* The persisted outcome is authoritative. */}})());
 return Response.json({type:5,data:{flags:64,allowed_mentions:{parse:[]}}});
}
export async function attachmentAdmin(request:Request,env:Env,actor:{userId:string;expiresAt:number}){
 if(env.ALLOWED_ORIGIN!==attachmentDevelopmentOrigin)fail();const match=/^\/admin\/integrations\/discord\/attachment-proofs\/([a-f0-9-]{36})(\/reconcile)?$/.exec(new URL(request.url).pathname);if(!match)fail();
 const row=await env.DB!.prepare("SELECT * FROM discord_attachment_proofs WHERE installation_id='primary' AND id=?").bind(match[1]).first<Row>();if(!row)fail();
 if(request.method==='GET'&&!match[2])return Response.json(await diagnosticSummary(env,row),{headers:{'cache-control':'no-store'}});
 if(request.method!=='POST'||!match[2]||Date.now()>=actor.expiresAt)fail();const body=await pickerInput(request);if(!object(body)||Object.keys(body).length!==1||body.confirmation!=='VERIFY SYNTHETIC ATTACHMENT')fail();
 if(row.status==='pending'){const client=await drive(env,row,Date.now()+25000,actor);await client.verify();}else if(row.status!=='saved')fail();
 return Response.json(await diagnosticSummary(env,row),{headers:{'cache-control':'no-store'}});
}
