import type {Env} from './index.ts';
import {discordReadDeadline} from './discord-platform.ts';
import {HttpError} from './http-error.ts';
import {encryptIntegration,decryptIntegration} from './integration-crypto.ts';
import {submitLinkedDiscordHours} from './hour-accounting.ts';
import {requestLinkedDiscordHourCorrection} from './hour-review-reports.ts';
import {CivilTimeError,addCalendarDays,instantToCivil,resolveCivilTime,selectCivilTime,elapsedIntegerMinutes} from '@lancerlogin/shared/civil-time';
import {editPrivateInteraction,type PrivateDiscordMessage} from './discord-interaction-reply.ts';

type Interaction={id?:string;application_id?:string;token?:string;type?:number;guild_id?:string;member?:{user?:{id?:string}};data?:{name?:string;custom_id?:string;values?:unknown;options?:unknown;components?:unknown}};
type Row={id:string;guild_id:string;discord_user_id:string;provider_iv:string;kind:'entry'|'correction';revision:number;expires_at:number;confirmation_id:string|null;ciphertext:string;iv:string};
type Choice={id:string;label:string;mode?:string};
type Draft={step:string;timeZone:string;today:string;earliest:string;choices:Choice[];next:string|null;cursor:string;categoryId?:string;categoryLabel?:string;mode?:string;serviceDate?:string;teamId?:string;activityId?:string;title?:string;startLocal?:string;endLocal?:string;endNextDay?:boolean;startOccurrence?:'earlier'|'later';endOccurrence?:'earlier'|'later';taskNotes?:string;message?:string;receiptId?:string;frozen?:Record<string,unknown>};
type Context={config:Record<string,string>;providerIv:string;user:string;guild:string;interaction:Interaction};
const snow=(v:unknown):v is string=>typeof v==='string'&&/^\d{10,24}$/.test(v);
const safe=(value:string,max=100)=>value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/([\\*_`~>|[\]])/g,'\\$1').replaceAll('@','@\u200b').slice(0,max);
const unavailable='Hours are unavailable or this private form expired. Start /hours or /hours-correction again, or ask a Staff member for help.';
const moduleGuard="EXISTS(SELECT 1 FROM platform_module_configuration WHERE installation_id='primary' AND hours_enabled=1)";
const providerGuard="EXISTS(SELECT 1 FROM encrypted_integrations i JOIN installations x ON x.id=i.installation_id WHERE i.installation_id='primary' AND i.provider='discord' AND i.iv=? AND i.verified_at IS NOT NULL AND x.discord_enabled=1)";
const privateResponse=(content:string)=>Response.json({type:4,data:{content,flags:64,allowed_mentions:{parse:[]}}});
const button=(label:string,id:string,style=2)=>({type:2,style,label,custom_id:id});
const actions=(...items:unknown[])=>({type:1,components:items});
const custom=(row:Row,action:string)=>`llh:${row.id}:${row.revision}:${action}`;
const again=(row:Row)=>actions(button('Edit details',custom(row,'modal')));
function fail():never{throw new HttpError(409,unavailable);}
async function gate(env:Env,context:Context){if(!await env.DB!.prepare(`SELECT 1 WHERE ${moduleGuard} AND ${providerGuard}`).bind(context.providerIv).first())fail();}
async function pack(env:Env,row:Pick<Row,'id'|'guild_id'|'discord_user_id'|'provider_iv'>,draft:Draft){return encryptIntegration({installation:'primary',id:row.id,guild:row.guild_id,user:row.discord_user_id,provider:row.provider_iv,payload:JSON.stringify(draft)},env.INTEGRATION_KEY!);}
async function unpack(env:Env,row:Row){const value=await decryptIntegration(row.ciphertext,row.iv,env.INTEGRATION_KEY!);if(value.installation!=='primary'||value.id!==row.id||value.guild!==row.guild_id||value.user!==row.discord_user_id||value.provider!==row.provider_iv)fail();return JSON.parse(value.payload) as Draft;}
async function update(env:Env,row:Row,draft:Draft){
 const encrypted=await pack(env,row,draft);const result=await env.DB!.prepare(`UPDATE discord_hour_drafts SET ciphertext=?,iv=?,revision=revision+1 WHERE installation_id='primary' AND id=? AND revision=? AND confirmation_id IS NULL AND expires_at>? AND ${moduleGuard} AND ${providerGuard}`).bind(encrypted.ciphertext,encrypted.iv,row.id,row.revision,Date.now(),row.provider_iv).run();if(result.meta?.changes!==1)fail();row.revision++;
}
async function contextDates(env:Env){const settings=await env.DB!.prepare("SELECT o.time_zone,s.reporting_days FROM organization_settings o JOIN hours_entry_settings s ON s.installation_id=o.installation_id WHERE o.installation_id='primary'").first<{time_zone:string;reporting_days:number}>();if(!settings||!Number.isSafeInteger(settings.reporting_days)||settings.reporting_days<1||settings.reporting_days>365)fail();const today=instantToCivil(Date.now(),settings.time_zone).date;return {timeZone:settings.time_zone,today,earliest:addCalendarDays(today,1-settings.reporting_days)};}
async function choices(env:Env,draft:Draft){
 let rows:any[]=[];const db=env.DB!,now=Date.now();
 if(draft.step==='category')rows=(await db.prepare("SELECT id,name AS label,mode FROM hours_categories WHERE installation_id='primary' AND archived=0 AND id>? ORDER BY id LIMIT 26").bind(draft.cursor).all()).results??[];
 else if(draft.step==='date'&&draft.mode==='event')rows=(await db.prepare("SELECT DISTINCT a.service_date AS id,a.service_date AS label FROM hours_activities a WHERE a.installation_id='primary' AND a.category_id=? AND a.mode='event' AND a.archived=0 AND a.service_date<=? AND (?='' OR a.service_date<?) AND (a.service_date>=? OR EXISTS(SELECT 1 FROM hours_reopen_windows w WHERE w.installation_id=a.installation_id AND w.revoked=0 AND w.starts_ms<=? AND w.expires_ms>? AND (w.activity_id IS NULL OR w.activity_id=a.id))) ORDER BY a.service_date DESC LIMIT 26").bind(draft.categoryId,draft.today,draft.cursor,draft.cursor,draft.earliest,now,now).all()).results??[];
 else if(draft.step==='date'){let day=draft.cursor?addCalendarDays(draft.cursor,-1):draft.today;for(let i=0;i<26&&day>=draft.earliest;i++){rows.push({id:day,label:day});if(day==='0000-01-01')break;day=addCalendarDays(day,-1);}}
 else if(draft.step==='event')rows=(await db.prepare("SELECT a.id,a.title AS label FROM hours_activities a WHERE a.installation_id='primary' AND a.category_id=? AND a.service_date=? AND a.mode='event' AND a.archived=0 AND a.id>? AND (a.service_date>=? OR EXISTS(SELECT 1 FROM hours_reopen_windows w WHERE w.installation_id=a.installation_id AND w.revoked=0 AND w.starts_ms<=? AND w.expires_ms>? AND (w.activity_id IS NULL OR w.activity_id=a.id))) ORDER BY a.id LIMIT 26").bind(draft.categoryId,draft.serviceDate,draft.cursor,draft.earliest,now,now).all()).results??[];
 else if(draft.step==='team')rows=(await db.prepare("SELECT id,trim(number||' '||name) AS label FROM hours_teams WHERE installation_id='primary' AND archived=0 AND id>? ORDER BY id LIMIT 26").bind(draft.cursor).all()).results??[];
 draft.choices=rows.slice(0,25).map(r=>({id:r.id,label:String(r.label),...(r.mode?{mode:r.mode}:{})}));draft.next=rows.length>25?draft.choices[24].id:null;
}
function render(row:Row,draft:Draft):PrivateDiscordMessage{
 if(row.confirmation_id)return {content:'This submission is frozen. Retry confirmation to recover its original result.',components:[actions(button('Check original result',custom(row,'confirm')))]};
 if(['category','date','event','team'].includes(draft.step)){
  const components:unknown[]=[];if(draft.choices.length)components.push(actions({type:3,custom_id:custom(row,'pick'),min_values:1,max_values:1,placeholder:'Choose '+draft.step,options:draft.choices.map((choice,i)=>({label:choice.label.slice(0,100),value:String(i)}))}));const paging=[];if(draft.cursor)paging.push(button('First page',custom(row,'first')));if(draft.next)paging.push(button('Next page',custom(row,'next')));if(paging.length)components.push(actions(...paging));return {content:`Choose ${draft.step}${draft.serviceDate?' for '+draft.serviceDate:''}. Dates use ${safe(draft.timeZone)}.${draft.choices.length?'':' No available choices. Ask Staff to check the activity catalog or reporting window.'}`,components};
 }
 if(draft.step==='details')return {content:row.kind==='correction'?'Describe the correction privately. Staff will review it; this does not change your hours immediately.':`Enter your actual start and end for ${draft.serviceDate} (${safe(draft.timeZone)}). Choose next-day explicitly for an overnight interval.`,components:[again(row)]};
 if(draft.step==='fold-start'||draft.step==='fold-end'){
  const start=draft.step==='fold-start',date=start?draft.serviceDate!:addCalendarDays(draft.serviceDate!,Number(draft.endNextDay)),time=start?draft.startLocal!:draft.endLocal!,options=resolveCivilTime({date,time,timeZone:draft.timeZone});
  return {content:`The ${start?'start':'end'} clock occurs twice. Choose its UTC offset explicitly.`,components:[actions(...options.map((option,index)=>button((index?'Later':'Earlier')+' UTC'+offset(option.offsetSeconds),custom(row,(start?'start-':'end-')+(index?'later':'earlier'))))),again(row)]};
 }
 return {content:row.kind==='correction'?`Review correction request${draft.serviceDate?' for '+draft.serviceDate:''}. Your description will go privately to Staff.`:`Review ${safe(draft.categoryLabel??"Service")}${draft.title?" - "+safe(draft.title):""}, ${draft.serviceDate}: ${draft.startLocal} to ${draft.endLocal}${draft.endNextDay?' next day':''} in ${safe(draft.timeZone)}. ${minutes(draft)} minutes. Notes remain private.`,components:[actions(button(row.kind==='correction'?'Send correction request':'Record these hours',custom(row,'confirm'),1)),again(row)]};
}
function offset(seconds:number){const sign=seconds<0?'-':'+';seconds=Math.abs(seconds);return sign+String(Math.floor(seconds/3600)).padStart(2,'0')+':'+String(Math.floor(seconds%3600/60)).padStart(2,'0')+(seconds%60?':'+String(seconds%60).padStart(2,'0'):'');}
function minutes(d:Draft){const start=selectCivilTime({date:d.serviceDate!,time:d.startLocal!,timeZone:d.timeZone},d.startOccurrence),end=selectCivilTime({date:addCalendarDays(d.serviceDate!,Number(d.endNextDay)),time:d.endLocal!,timeZone:d.timeZone},d.endOccurrence);if(end.epochMilliseconds>Date.now())throw new HttpError(400,'Completed hours cannot end in the future. Edit details.');return elapsedIntegerMinutes(start.epochMilliseconds,end.epochMilliseconds);}
function review(draft:Draft){const start=resolveCivilTime({date:draft.serviceDate!,time:draft.startLocal!,timeZone:draft.timeZone}),end=resolveCivilTime({date:addCalendarDays(draft.serviceDate!,Number(draft.endNextDay)),time:draft.endLocal!,timeZone:draft.timeZone});if(!start.length||!end.length)throw new HttpError(400,'That clock does not exist because daylight saving time skips it. Edit details.');draft.step=start.length===2&&!draft.startOccurrence?'fold-start':end.length===2&&!draft.endOccurrence?'fold-end':'review';if(draft.step==='review')minutes(draft);}
function modal(row:Row,draft:Draft){
 const input=(id:string,label:string,max:number,required=true,style=1,value='')=>actions({type:4,custom_id:id,label,style,max_length:max,required,...(value?{value}:{})});
 return Response.json({type:9,data:{custom_id:custom(row,'details'),title:row.kind==='correction'?'Request an hours correction':'Completed service hours',components:row.kind==='correction'?[input('message','What should Staff correct?',2000,true,2,draft.message),input('date','Service date (YYYY-MM-DD), if known',10,false,1,draft.serviceDate),input('receipt','Your receipt reference, if available',128,false,1,draft.receiptId)]:[input('start','Start clock (HH:mm)',12,true,1,draft.startLocal),input('end','End clock (HH:mm)',12,true,1,draft.endLocal),input('next','End on next date? Enter yes or no',3,true,1,draft.endNextDay?'yes':'no'),input('notes','Private notes (optional)',2000,false,2,draft.taskNotes)]}});
}
function modalValues(value:unknown,allowed:string[]){if(!Array.isArray(value)||value.length!==allowed.length)fail();const result:Record<string,string>={};for(const row of value){if(!row||row.type!==1||!Array.isArray(row.components)||row.components.length!==1)fail();const field=row.components[0];if(!field||field.type!==4||!allowed.includes(field.custom_id)||field.custom_id in result||typeof field.value!=='string'||field.value.length>2000)fail();result[field.custom_id]=field.value.trim();}return result;}
async function load(env:Env,context:Context,id:string){const row=await env.DB!.prepare("SELECT * FROM discord_hour_drafts WHERE installation_id='primary' AND id=? AND guild_id=? AND discord_user_id=? AND provider_iv=? AND expires_at>?").bind(id,context.guild,context.user,context.providerIv,Date.now()).first<Row>();if(!row)fail();return row;}
async function process(env:Env,context:Context):Promise<PrivateDiscordMessage>{
 await gate(env,context);const db=env.DB!,interaction=context.interaction;
 await db.prepare("DELETE FROM discord_hour_drafts WHERE installation_id='primary' AND expires_at<=?").bind(Date.now()).run();
 if(interaction.type===2){
  if(interaction.data?.options!==undefined&&(!Array.isArray(interaction.data.options)||interaction.data.options.length))fail();
  if(!await db.prepare("SELECT id FROM members WHERE installation_id='primary' AND discord_user_id=? AND active=1").bind(context.user).first())return {content:'Pair your Discord account with /pair using your member ID first. Ask an Operator if you need help.'};
  const kind=interaction.data?.name==='hours'?'entry':'correction',row:Row={id:crypto.randomUUID(),guild_id:context.guild,discord_user_id:context.user,provider_iv:context.providerIv,kind,revision:0,expires_at:Date.now()+20*60000,confirmation_id:null,ciphertext:'',iv:''};
  const draft:Draft={...await contextDates(env),step:kind==='entry'?'category':'details',choices:[],next:null,cursor:''};if(kind==='entry')await choices(env,draft);const encrypted=await pack(env,row,draft);
  const result=await db.prepare(`INSERT INTO discord_hour_drafts(installation_id,id,guild_id,discord_user_id,provider_iv,kind,expires_at,ciphertext,iv) SELECT 'primary',?,?,?,?,?,?,?,? WHERE ${moduleGuard} AND ${providerGuard} AND (SELECT COUNT(*) FROM discord_hour_drafts WHERE installation_id='primary')<256 AND (SELECT COUNT(*) FROM discord_hour_drafts WHERE installation_id='primary' AND guild_id=? AND discord_user_id=?)<4`).bind(row.id,row.guild_id,row.discord_user_id,row.provider_iv,row.kind,row.expires_at,encrypted.ciphertext,encrypted.iv,row.provider_iv,context.guild,context.user).run();if(result.meta?.changes!==1)fail();return render(row,draft);
 }
 const match=/^llh:([a-f0-9-]{36}):(\d{1,8}):([a-z-]{1,20})$/.exec(interaction.data?.custom_id??'');if(!match)fail();const row=await load(env,context,match[1]),draft=await unpack(env,row),action=match[3];
 if(action==='confirm'&&interaction.type===3&&(draft.step==='review'||row.confirmation_id)){
  if(!row.confirmation_id){if(Number(match[2])!==row.revision)fail();const id=interaction.id!;draft.frozen=row.kind==='correction'?{idempotencyKey:id,message:draft.message,...(draft.serviceDate?{serviceDate:draft.serviceDate}:{}),...(draft.receiptId?{receiptId:draft.receiptId}:{})}:{idempotencyKey:id,expectedTimeZone:draft.timeZone,serviceDate:draft.serviceDate,...(draft.activityId?{activityId:draft.activityId}:{categoryId:draft.categoryId,...(draft.teamId?{teamId:draft.teamId}:{})}),startLocal:draft.startLocal,endLocal:draft.endLocal,endNextDay:draft.endNextDay,...(draft.startOccurrence?{startOccurrence:draft.startOccurrence}:{}),...(draft.endOccurrence?{endOccurrence:draft.endOccurrence}:{}),taskNotes:draft.taskNotes??''};
   const encrypted=await pack(env,row,draft);await db.prepare(`UPDATE discord_hour_drafts SET confirmation_id=?,ciphertext=?,iv=?,revision=revision+1 WHERE installation_id='primary' AND id=? AND revision=? AND confirmation_id IS NULL AND expires_at>? AND ${moduleGuard} AND ${providerGuard}`).bind(id,encrypted.ciphertext,encrypted.iv,row.id,row.revision,Date.now(),row.provider_iv).run();
  }
  const frozenRow=await load(env,context,row.id),frozen=await unpack(env,frozenRow);if(!frozenRow.confirmation_id||frozen.frozen?.idempotencyKey!==frozenRow.confirmation_id)fail();await gate(env,context);
  // Domain immutable retry lookup precedes current pairing lookup. Never preflight
  // pairing here: a successful original receipt survives later pairing changes.
  try{const result:any=row.kind==='correction'?await requestLinkedDiscordHourCorrection(db,'primary',context.user,frozen.frozen,Date.now(),context.providerIv):await submitLinkedDiscordHours(db,'primary',context.user,frozen.frozen,Date.now(),context.providerIv);return {content:row.kind==='correction'?`Correction request received. Reference: ${result.reference}. Staff review will not change hours until resolved.`:`Recorded ${result.duration_minutes} minutes for ${result.service_date}. Receipt: ${result.id}.`,components:[]};}
  catch{return {content:'These details were not confirmed. Retry the frozen confirmation to recover an original success; otherwise ask Staff or use /hours-correction. Do not submit a second copy of uncertain hours.',components:[actions(button('Retry frozen confirmation',custom(frozenRow,'confirm')))]};}
 }
 if(row.confirmation_id||Number(match[2])!==row.revision)fail();
 if((action==='next'||action==='first')&&interaction.type===3){if(!['category','date','event','team'].includes(draft.step)||action==='next'&&!draft.next)fail();draft.cursor=action==='next'?draft.next!:'';await choices(env,draft);}
 else if(action==='pick'&&interaction.type===3){
  const values=interaction.data?.values;if(!Array.isArray(values)||values.length!==1||typeof values[0]!=='string'||!/^\d{1,2}$/.test(values[0]))fail();const chosen=draft.choices[Number(values[0])];if(!chosen)fail();
  if(draft.step==='category'){draft.categoryId=chosen.id;draft.categoryLabel=chosen.label;draft.mode=chosen.mode;draft.step='date';}
  else if(draft.step==='date'){draft.serviceDate=chosen.id;draft.step=draft.mode==='event'?'event':draft.mode==='team'?'team':'details';}
  else if(draft.step==='event'){draft.activityId=chosen.id;draft.title=chosen.label;draft.step='details';}
  else if(draft.step==='team'){draft.teamId=chosen.id;draft.title=chosen.label;draft.step='details';}else fail();draft.cursor='';await choices(env,draft);
 }else if(action==='details'&&interaction.type===5){
  if(!['details','review','fold-start','fold-end'].includes(draft.step))fail();
  if(row.kind==='correction'){const fields=modalValues(interaction.data?.components,['message','date','receipt']);if(!fields.message)fail();draft.message=fields.message;draft.serviceDate=fields.date?addCalendarDays(fields.date,0):undefined;draft.receiptId=fields.receipt||undefined;draft.step='review';}
  else{const fields=modalValues(interaction.data?.components,['start','end','next','notes']);if(!['yes','no'].includes(fields.next.toLowerCase()))throw new HttpError(400,'Enter yes or no for next-day end. Open Edit details again.');draft.startLocal=fields.start;draft.endLocal=fields.end;draft.endNextDay=fields.next.toLowerCase()==='yes';draft.taskNotes=fields.notes;draft.startOccurrence=undefined;draft.endOccurrence=undefined;review(draft);}
 }else if(['start-earlier','start-later','end-earlier','end-later'].includes(action)&&interaction.type===3){
  const start=action.startsWith('start-');if(draft.step!==(start?'fold-start':'fold-end'))fail();if(start)draft.startOccurrence=action.endsWith('earlier')?'earlier':'later';else draft.endOccurrence=action.endsWith('earlier')?'earlier':'later';review(draft);
 }else fail();
 await update(env,row,draft);return render(row,draft);
}
export function isHourDiscord(interaction:Interaction){return interaction.type===2&&['hours','hours-correction'].includes(interaction.data?.name??'')||[3,5].includes(interaction.type??0)&&typeof interaction.data?.custom_id==='string'&&interaction.data.custom_id.startsWith('llh:');}
export async function hourDiscordInteraction(env:Env,interaction:Interaction,config:Record<string,string>,providerIv:string,execution:{waitUntil(promise:Promise<unknown>):void}|undefined,receivedAt=Date.now()){
 if(!env.DB||!env.INTEGRATION_KEY||!snow(interaction.id)||interaction.application_id!==config.applicationId||interaction.guild_id!==config.guildId||!snow(interaction.member?.user?.id)||!execution||typeof interaction.token!=='string'||!/^[A-Za-z0-9._-]{1,2048}$/.test(interaction.token))return privateResponse(unavailable);
 const context:Context={config,providerIv,user:interaction.member.user.id,guild:interaction.guild_id!,interaction};
 if(Date.now()-receivedAt>2500)return privateResponse('This interaction arrived too slowly. Try the command again.');
 if(interaction.type===3&&interaction.data?.custom_id?.endsWith(':modal')){
  try{return await discordReadDeadline((async()=>{await gate(env,context);const match=/^llh:([a-f0-9-]{36}):(\d{1,8}):modal$/.exec(interaction.data?.custom_id??'');if(!match)fail();const row=await load(env,context,match[1]);if(row.confirmation_id||row.revision!==Number(match[2])||Date.now()-receivedAt>2500)fail();const draft=await unpack(env,row);if(!['details','review','fold-start','fold-end'].includes(draft.step))fail();return modal(row,draft);})(),receivedAt+2500);}catch{return privateResponse(unavailable);}
 }
 const token=interaction.token,application=config.applicationId;
 execution.waitUntil((async()=>{let message:PrivateDiscordMessage;try{message=await process(env,context);}catch(error){message={content:error instanceof CivilTimeError?"Check the date and clocks. Use valid HH:mm times with a positive whole-minute interval. Open Edit details again.":error instanceof HttpError&&error.status===400?safe(error.message,1500):unavailable};}try{await editPrivateInteraction(application,token,message,receivedAt+14*60000, undefined, env);}catch{/* no tokens/provider diagnostics; a later button retry recovers domain success */}})());
 return Response.json({type:5,data:{flags:64,allowed_mentions:{parse:[]}}});
}
