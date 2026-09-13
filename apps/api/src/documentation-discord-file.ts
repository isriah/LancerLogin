import { providerFetch } from './maintenance.ts';
import type {Env} from './index.ts';
import {discordReadDeadline} from './discord-platform.ts';
import {encryptIntegration,decryptIntegration} from './integration-crypto.ts';
import {admitUpload,advanceUpload,readOriginalBytes} from './documentation-upload.ts';
import {discordAttachmentUrl} from './discord-attachment-feasibility.ts';
import {documentationBodyHash} from '@lancerlogin/shared/documentation-proxy';
import {editPrivateInteraction,type PrivateDiscordMessage} from './discord-interaction-reply.ts';
type Interaction={id?:string;application_id?:string;token?:string;type?:number;guild_id?:string;member?:{user?:{id?:string}};data?:{name?:string;custom_id?:string;values?:unknown;options?:unknown;components?:unknown;resolved?:unknown}};
type Row={id:string;guild_id:string;discord_user_id:string;provider_iv:string;revision:number;expires_at:number;confirmation_id:string|null;ciphertext:string;iv:string;lease_token?:string|null};
type Choice={id:string;title:string;serviceDate:string;revision:number};
type Source={id:string;url:string;size:number;mime:string};
type Draft={step:'activity'|'details';choices:Choice[];cursor:string;next:string|null;sectionRevision:number;activity?:Choice;source?:Source;memberId?:string;admission?:Record<string,unknown>;reference?:string};
type Context={user:string;guild:string;providerIv:string;interaction:Interaction};
const unavailable='Activity files are unavailable or this private form expired. Start /activity-file again, or ask Staff to check an uncertain submission before sending another copy.';
const moduleGuard="EXISTS(SELECT 1 FROM platform_module_configuration WHERE installation_id='primary' AND hours_enabled=1 AND documentation_enabled=1) AND COALESCE((SELECT files_enabled FROM documentation_sections WHERE installation_id='primary'),1)=1";
const providerGuard="EXISTS(SELECT 1 FROM encrypted_integrations i JOIN installations x ON x.id=i.installation_id WHERE i.installation_id='primary' AND i.provider='discord' AND i.iv=? AND i.verified_at IS NOT NULL AND x.discord_enabled=1)";
const selectionGuard="COALESCE((SELECT revision FROM documentation_sections WHERE installation_id='primary'),0)=? AND EXISTS(SELECT 1 FROM hours_activities WHERE installation_id='primary' AND id=? AND revision=? AND archived=0 AND impact_relevant=1)";
const memberGuard="EXISTS(SELECT 1 FROM members WHERE installation_id='primary' AND active=1 AND discord_user_id=?)";
const snow=(value:unknown):value is string=>typeof value==='string'&&/^\d{10,24}$/.test(value);
const safe=(value:string)=>value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/([\\*_`~>|[\]])/g,'\\$1').replaceAll('@','@\u200b').slice(0,100);
function fail():never{throw Error(unavailable);}
const actions=(...components:unknown[])=>({type:1,components});
const custom=(row:Row,action:string)=>`lldf:${row.id}:${row.revision}:${action}`;
const button=(row:Row,label:string,action:string)=>({type:2,style:2,label,custom_id:custom(row,action)});
const privateResponse=(content:string)=>Response.json({type:4,data:{content,flags:64,allowed_mentions:{parse:[]}}});
async function gate(env:Env,context:Context,member=false){if(!await env.DB!.prepare(`SELECT 1 WHERE ${moduleGuard} AND ${providerGuard}${member?' AND '+memberGuard:''}`).bind(context.providerIv,...(member?[context.user]:[])).first())fail();}
async function pack(env:Env,row:Row,draft:Draft){return encryptIntegration({installation:'primary',id:row.id,guild:row.guild_id,user:row.discord_user_id,provider:row.provider_iv,payload:JSON.stringify(draft)},env.INTEGRATION_KEY!);}
async function unpack(env:Env,row:Row):Promise<Draft>{const v=await decryptIntegration(row.ciphertext,row.iv,env.INTEGRATION_KEY!);if(v.installation!=='primary'||v.id!==row.id||v.guild!==row.guild_id||v.user!==row.discord_user_id||v.provider!==row.provider_iv)fail();return JSON.parse(v.payload);}
async function load(env:Env,c:Context,id:string){const row=await env.DB!.prepare("SELECT * FROM discord_documentation_file_drafts WHERE installation_id='primary' AND id=? AND guild_id=? AND discord_user_id=? AND provider_iv=? AND expires_at>?").bind(id,c.guild,c.user,c.providerIv,Date.now()).first<Row>();if(!row)fail();return row;}
async function choices(env:Env,draft:Draft){const result=await env.DB!.prepare(`SELECT id,title,service_date AS serviceDate,revision,COALESCE((SELECT revision FROM documentation_sections WHERE installation_id='primary'),0) AS sectionRevision FROM hours_activities WHERE installation_id='primary' AND archived=0 AND impact_relevant=1 AND id>? AND ${moduleGuard} ORDER BY id LIMIT 26`).bind(draft.cursor).all<Choice&{sectionRevision:number}>();const rows=result.results??[];draft.choices=rows.slice(0,25).map(({id,title,serviceDate,revision})=>({id,title,serviceDate,revision}));draft.next=rows.length>25?rows[24].id:null;if(rows.length)draft.sectionRevision=rows[0].sectionRevision;}
function render(row:Row,draft:Draft):PrivateDiscordMessage{
 if(row.confirmation_id)return continuation(row,draft);
 if(draft.step==='activity'){const components:unknown[]=[];if(draft.choices.length)components.push(actions({type:3,custom_id:custom(row,'pick'),min_values:1,max_values:1,placeholder:'Choose an activity',options:draft.choices.map((choice,index)=>({label:safe(choice.title),description:choice.serviceDate,value:String(index)}))}));components.push(actions(button(row,'First page','first'),...(draft.next?[button(row,'Next page','next')]:[])));return {content:draft.choices.length?'Choose the activity for one private file up to 4 MiB. This does not record hours.':'No eligible activities. Ask Staff to check the activity catalog.',components};}
 return {content:`Attach one private file up to 4 MiB for ${safe(draft.activity!.title)}. Staff can review it after original-file verification. This does not record hours or publish the file.`,components:[actions(button(row,'Attach file','modal'))]};
}
function modal(row:Row,_draft:Draft){return Response.json({type:9,data:{custom_id:custom(row,'details'),title:'Private activity file',components:[{type:18,label:'One original file, up to 4 MiB',component:{type:19,custom_id:'original',min_values:1,max_values:1,required:true}}]}});}
export function selectedDocumentationFile(data:any):Source{
 if(!data||!Array.isArray(data.components)||data.components.length!==1)fail();const label=data.components[0],field=label?.component;
 if(label?.type!==18||field?.type!==19||field.custom_id!=='original'||!Array.isArray(field.values)||field.values.length!==1||!snow(field.values[0]))fail();
 const id=field.values[0],resolved=data.resolved?.attachments,a=resolved?.[id];
 if(!resolved||Array.isArray(resolved)||Object.keys(resolved).length!==1||!a||a.id!==id||typeof a.filename!=='string'||!a.filename.length||a.filename.length>255||typeof a.content_type!=='string'||a.content_type.length>100||!/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/.test(a.content_type)||!Number.isSafeInteger(a.size)||a.size<1||a.size>4194304)fail();
 return {id,url:discordAttachmentUrl(a.url,id),size:a.size,mime:a.content_type};
}
export async function downloadDocumentationFile(source:Source, env?: Env){
 const url=discordAttachmentUrl(source.url,source.id),signal=AbortSignal.timeout(6000);
 const response=await providerFetch(env)(url,{redirect:'manual',signal});
 const length=response.headers.get('content-length');if(!response.ok||!response.body||length!==null&&(!/^\d+$/.test(length)||Number(length)!==source.size)){void response.body?.cancel().catch(()=>{});fail();}
 const bytes=await readOriginalBytes(response,4194304,signal);if(bytes.length!==source.size)fail();return bytes;
}
function continuation(row:Row,draft:Draft,state?:string):PrivateDiscordMessage{return {content:`File ${draft.reference?'reference: '+draft.reference+'. ':''}${state?'Current state: '+state+'. ':''}is not confirmed saved. Continue/check this same upload; do not submit another copy. If this form expires, ask Staff to reconcile the reference. Hours and notes remain separate.`,components:[actions(button(row,'Continue / check upload','continue'))]};}
async function persistFrozen(env:Env,row:Row,draft:Draft){const encrypted=await pack(env,row,draft);const result=await env.DB!.prepare(`UPDATE discord_documentation_file_drafts SET ciphertext=?,iv=? WHERE installation_id='primary' AND id=? AND confirmation_id=? AND lease_token=? AND lease_expires_ms>? AND expires_at>? AND ${moduleGuard} AND ${providerGuard} AND ${memberGuard}`).bind(encrypted.ciphertext,encrypted.iv,row.id,row.confirmation_id,row.lease_token,Date.now(),Date.now(),row.provider_iv,row.discord_user_id).run();if(result.meta?.changes!==1)fail();}
async function transfer(env:Env,c:Context,row:Row,draft:Draft):Promise<PrivateDiscordMessage>{
 const lease=crypto.randomUUID(),now=Date.now();const claim=await env.DB!.prepare(`UPDATE discord_documentation_file_drafts SET lease_token=?,lease_expires_ms=? WHERE installation_id='primary' AND id=? AND confirmation_id=? AND lease_expires_ms<=? AND expires_at>? AND ${moduleGuard} AND ${providerGuard} AND ${memberGuard}`).bind(lease,now+120000,row.id,row.confirmation_id,now,now,c.providerIv,c.user).run();if(claim.meta?.changes!==1)return continuation(row,draft);
 row.lease_token=lease;
 try{
  // Reload after acquiring the lease: another continuation may have frozen admission.
  draft=await unpack(env,await load(env,c,row.id));
  let original:Uint8Array|undefined;
  if(!draft.admission){if(!draft.source||!draft.activity||!draft.memberId)fail();original=await downloadDocumentationFile(draft.source, env);draft.admission={title:'Activity file',caption:'',mime:draft.source.mime,byteLength:original.length,sha256:await documentationBodyHash(original),activities:[{activityId:draft.activity.id,revision:draft.activity.revision}],initiatives:[],sectionRevision:draft.sectionRevision,idempotencyKey:row.confirmation_id!};await persistFrozen(env,row,draft);}
  const result=await admitUpload(env,draft.admission,{source:'discord',memberId:draft.memberId!,discordUserId:c.user,expectedDiscordIV:c.providerIv});
  draft.reference=result.reference;await persistFrozen(env,row,draft);
  if(result.saved)return {content:`Original file saved privately and verified. Reference: ${result.reference}. Staff review and publication are separate.`,components:[]};
  let operation=await env.DB!.prepare("SELECT * FROM documentation_upload_operations WHERE installation_id='primary' AND id=?").bind(result.reference).first<Record<string,any>>();if(!operation)fail();
  // One shared phase per interaction. Chunk transfer uses at most four chunks and
  // a 20-second dispatch budget, then asks for explicit private continuation.
  if(operation.state==='uploading'&&operation.next_chunk<Math.ceil(operation.byte_length/262144)){
   original??=await downloadDocumentationFile(draft.source!, env);if(await documentationBodyHash(original)!==draft.admission.sha256)fail();
   for(let count=0;count<4&&Date.now()<now+20000&&operation.next_chunk<Math.ceil(operation.byte_length/262144);count++){
    const n=operation.next_chunk;await gate(env,c,true);await advanceUpload(env,operation,'chunks/'+n,original.slice(n*262144,(n+1)*262144));
    operation=(await env.DB!.prepare("SELECT * FROM documentation_upload_operations WHERE installation_id='primary' AND id=?").bind(result.reference).first<Record<string,any>>())!;
   }
   return continuation(row,draft,operation.state);
  }
  // Once compute owns every original chunk, discard temporary CDN authority.
  if(draft.source){delete draft.source;await persistFrozen(env,row,draft);}
  const advanced=await advanceUpload(env,operation,operation.state==='uploading'?'seal':'advance');
  return advanced.saved?{content:`Original file saved privately and verified. Reference: ${result.reference}. Staff review and publication are separate.`,components:[]}:continuation(row,draft,advanced.state);
 }catch{return continuation(row,draft);}finally{await env.DB!.prepare("UPDATE discord_documentation_file_drafts SET lease_token=NULL,lease_expires_ms=0 WHERE installation_id='primary' AND id=? AND lease_token=?").bind(row.id,lease).run();}
}

async function update(env:Env,row:Row,draft:Draft){const encrypted=await pack(env,row,draft);const result=await env.DB!.prepare(`UPDATE discord_documentation_file_drafts SET ciphertext=?,iv=?,revision=revision+1 WHERE installation_id='primary' AND id=? AND revision=? AND confirmation_id IS NULL AND expires_at>? AND ${moduleGuard} AND ${providerGuard} AND ${memberGuard}${draft.activity?' AND '+selectionGuard:''}`).bind(encrypted.ciphertext,encrypted.iv,row.id,row.revision,Date.now(),row.provider_iv,row.discord_user_id,...(draft.activity?[draft.sectionRevision,draft.activity.id,draft.activity.revision]:[])).run();if(result.meta?.changes!==1)fail();row.revision++;}
async function process(env:Env,c:Context):Promise<PrivateDiscordMessage>{await gate(env,c);const db=env.DB!,interaction=c.interaction;await db.prepare("DELETE FROM discord_documentation_file_drafts WHERE installation_id='primary' AND expires_at<=?").bind(Date.now()).run();
 if(interaction.type===2){if(interaction.data?.options!==undefined&&(!Array.isArray(interaction.data.options)||interaction.data.options.length))fail();await gate(env,c,true);const row:Row={id:crypto.randomUUID(),guild_id:c.guild,discord_user_id:c.user,provider_iv:c.providerIv,revision:0,expires_at:Date.now()+20*60000,confirmation_id:null,ciphertext:'',iv:''};const draft:Draft={step:'activity',choices:[],cursor:'',next:null,sectionRevision:0};await choices(env,draft);const encrypted=await pack(env,row,draft);const result=await db.prepare(`INSERT INTO discord_documentation_file_drafts(installation_id,id,guild_id,discord_user_id,provider_iv,expires_at,ciphertext,iv) SELECT 'primary',?,?,?,?,?,?,? WHERE ${moduleGuard} AND ${providerGuard} AND ${memberGuard} AND (SELECT COUNT(*) FROM discord_documentation_file_drafts WHERE installation_id='primary')<256 AND (SELECT COUNT(*) FROM discord_documentation_file_drafts WHERE installation_id='primary' AND discord_user_id=?)<4`).bind(row.id,row.guild_id,row.discord_user_id,row.provider_iv,row.expires_at,encrypted.ciphertext,encrypted.iv,c.providerIv,c.user,c.user).run();if(result.meta?.changes!==1)fail();return render(row,draft);}
 const match=/^lldf:([a-f0-9-]{36}):(\d{1,8}):([a-z-]{1,20})$/.exec(interaction.data?.custom_id??'');if(!match)fail();const row=await load(env,c,match[1]),draft=await unpack(env,row),action=match[3];
 if((action==='details'&&interaction.type===5||action==='continue'&&interaction.type===3)&&row.confirmation_id)return transfer(env,c,row,draft);
 if(action==='details'&&interaction.type===5){
  if(row.revision!==Number(match[2])||draft.step!=='details'||!draft.activity)fail();await gate(env,c,true);
  draft.source=selectedDocumentationFile(interaction.data);const member=await db.prepare("SELECT id FROM members WHERE installation_id='primary' AND active=1 AND discord_user_id=?").bind(c.user).first<{id:string}>();if(!member)fail();draft.memberId=member.id;
  const encrypted=await pack(env,row,draft);await db.prepare(`UPDATE discord_documentation_file_drafts SET confirmation_id=?,ciphertext=?,iv=?,revision=revision+1 WHERE installation_id='primary' AND id=? AND revision=? AND confirmation_id IS NULL AND expires_at>? AND ${moduleGuard} AND ${providerGuard} AND ${memberGuard} AND ${selectionGuard}`).bind(interaction.id,encrypted.ciphertext,encrypted.iv,row.id,row.revision,Date.now(),c.providerIv,c.user,draft.sectionRevision,draft.activity.id,draft.activity.revision).run();
  const frozenRow=await load(env,c,row.id);if(!frozenRow.confirmation_id)fail();return transfer(env,c,frozenRow,await unpack(env,frozenRow));
 }
 if(row.confirmation_id||row.revision!==Number(match[2]))fail();await gate(env,c,true);
 if((action==='first'||action==='next')&&interaction.type===3){if(draft.step!=='activity'||action==='next'&&!draft.next)fail();draft.cursor=action==='next'?draft.next!:'';await choices(env,draft);}
 else if(action==='pick'&&interaction.type===3){const value=interaction.data?.values;if(draft.step!=='activity'||!Array.isArray(value)||value.length!==1||typeof value[0]!=='string'||!/^\d{1,2}$/.test(value[0])||!draft.choices[Number(value[0])])fail();draft.activity=draft.choices[Number(value[0])];draft.step='details';}
 else fail();await update(env,row,draft);return render(row,draft);
}
export function isDocumentationFileDiscord(i:Interaction){return i.type===2&&i.data?.name==='activity-file'||[3,5].includes(i.type??0)&&typeof i.data?.custom_id==='string'&&i.data.custom_id.startsWith('lldf:');}
export async function documentationFileDiscordInteraction(env:Env,interaction:Interaction,config:Record<string,string>,providerIv:string,execution:{waitUntil(p:Promise<unknown>):void}|undefined,receivedAt=Date.now()){
 if(!env.DB||!env.INTEGRATION_KEY||!snow(interaction.id)||interaction.application_id!==config.applicationId||interaction.guild_id!==config.guildId||!snow(interaction.member?.user?.id)||!execution||typeof interaction.token!=='string'||!/^[A-Za-z0-9._-]{1,2048}$/.test(interaction.token)||Date.now()-receivedAt>2500)return privateResponse(unavailable);
 const c:Context={user:interaction.member.user.id,guild:interaction.guild_id!,providerIv,interaction};
 if(interaction.type===3&&interaction.data?.custom_id?.endsWith(':modal')){try{return await discordReadDeadline((async()=>{await gate(env,c,true);const match=/^lldf:([a-f0-9-]{36}):(\d{1,8}):modal$/.exec(interaction.data?.custom_id??'');if(!match)fail();const row=await load(env,c,match[1]),draft=await unpack(env,row);if(row.confirmation_id||row.revision!==Number(match[2])||draft.step!=='details'||Date.now()-receivedAt>2500)fail();if(!draft.activity||!await env.DB!.prepare(`SELECT 1 WHERE ${selectionGuard}`).bind(draft.sectionRevision,draft.activity.id,draft.activity.revision).first())fail();return modal(row,draft);})(),receivedAt+2500);}catch{return privateResponse(unavailable);}}
 const token=interaction.token;execution.waitUntil((async()=>{let message:PrivateDiscordMessage;try{message=await process(env,c);}catch{message={content:unavailable};}try{await editPrivateInteraction(config.applicationId,token,message,receivedAt+14*60000, undefined, env);}catch{/* An explicit continuation recovers the same operation. */}})());return Response.json({type:5,data:{flags:64,allowed_mentions:{parse:[]}}});
}
