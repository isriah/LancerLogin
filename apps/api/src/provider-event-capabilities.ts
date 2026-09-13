import { providerFetch } from './maintenance.ts';
import type {Env} from './index.ts';
import {googleCapability,readGoogleBody} from './google-connection.ts';
import {discordInteractionConfiguration,discordRequest,DiscordResponseError} from './discord-platform.ts';
import {schedulerBudgetKey} from './scheduler-budget.ts';
export type EventProvider='google'|'discord';
export type PublicationSnapshot={title:string;description:string;location:string;serviceDate:string;timeZone:string;startsAt:string|null;endsAt:string|null};
export class PublicationReviewError extends Error {}
type Remote={id:string;etag?:string};
const mismatch=()=>{throw new PublicationReviewError('Provider ownership or connection requires review');};
const snow=(v:unknown):v is string=>typeof v==='string'&&/^\d{10,24}$/.test(v);
export const eventProviderFence=(provider:EventProvider)=>provider==='google'
 ? "EXISTS(SELECT 1 FROM google_connections c JOIN installations x ON x.id=c.installation_id WHERE c.installation_id='primary' AND c.active_iv=? AND c.grant_error IS NOT 'revoked' AND x.google_calendar_enabled=1)"
 : "EXISTS(SELECT 1 FROM encrypted_integrations c JOIN installations x ON x.id=c.installation_id WHERE c.installation_id='primary' AND c.provider='discord' AND c.iv=? AND c.verified_at IS NOT NULL AND x.discord_enabled=1)";

/** Central provider adapter. Feature modules receive identity and bounded operations,
 * never refresh/client secrets or bot credentials. No remote URL is caller supplied. */
export async function eventProviderCapability(env:Env,provider:EventProvider){
 const db=env.DB!;
 if(provider==='google'){
  const capability=await googleCapability(env,'calendar');
  if(!capability.calendarVerified||!capability.calendarId||!capability.signature)mismatch();
  const identity={generation:capability.generation,destination:capability.calendarId!,applicationId:'',signature:capability.signature};
  let token:Promise<string>|undefined;
  const current=async()=>{if(!await db.prepare('SELECT 1 WHERE '+eventProviderFence(provider)).bind(identity.signature).first())mismatch();};
  await current();
  const call=async(method:string,id:string|undefined,payload?:unknown,etag?:string,preflight?:()=>Promise<void>)=>{
   token??=capability.accessToken();const bearer=await token;await current();
   if(id!==undefined&&!/^[a-v0-9]{5,128}$/.test(id))mismatch();
   if(preflight)await preflight();
   env[schedulerBudgetKey]?.request();
   const url='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(identity.destination)+'/events'+(id?'/'+id:'')+'?sendUpdates=none';
   const response=await providerFetch(env)(url,{method,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+bearer,'content-type':'application/json',...(etag?{'if-match':etag}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
   if([404,410].includes(response.status))return null;
   if(response.status===409)throw new Error('Provider create requires reconciliation');
   if([401,403,412].includes(response.status))mismatch();
   if(!response.ok)throw new Error('Provider request failed');
   return readGoogleBody(response);
  };
  const eventId=(marker:string)=>'llh'+marker.replace(/[^a-f0-9]/g,'');
  const find=async(marker:string,id:string|null):Promise<Remote|null>=>{
   const expected=eventId(marker);if(id&&id!==expected)mismatch();const value=await call('GET',expected);if(!value)return null;
   if(value.id!==expected||(value.extendedProperties as any)?.private?.lancerloginHours!==marker)mismatch();
   if(typeof value.etag!=='string'||!/^"[^"\r\n]+"$/.test(value.etag))mismatch();
   return {id:expected,etag:value.etag as string};
  };
  const payload=(marker:string,s:PublicationSnapshot)=>({summary:s.title,description:s.description,location:s.location,
   start:s.startsAt?{dateTime:s.startsAt,timeZone:s.timeZone}:{date:s.serviceDate},
   end:s.endsAt?{dateTime:s.endsAt,timeZone:s.timeZone}:{date:new Date(Date.parse(s.serviceDate+'T00:00:00Z')+86400000).toISOString().slice(0,10)},
   extendedProperties:{private:{lancerloginHours:marker}},reminders:{useDefault:false},attendees:[]});
  return {...identity,find,current,
   create:async(marker:string,s:PublicationSnapshot,preflight:()=>Promise<void>)=>{const id=eventId(marker),result=await call('POST',undefined,{id,...payload(marker,s)},undefined,preflight);if(result?.id!==id)mismatch();return id;},
   update:async(marker:string,s:PublicationSnapshot,remote:Remote,preflight:()=>Promise<void>)=>{const result=await call('PATCH',remote.id,payload(marker,s),remote.etag,preflight);if(result?.id!==remote.id)mismatch();return remote.id;},
   remove:async(remote:Remote,preflight:()=>Promise<void>)=>{await call('DELETE',remote.id,undefined,remote.etag,preflight);},
  };
 }
 const {config,record}=await discordInteractionConfiguration(env);
 if(record.enabled!==1||!record.verifiedAt||!snow(config.applicationId)||!snow(config.guildId))mismatch();
 if(env[schedulerBudgetKey])Object.defineProperty(config,schedulerBudgetKey,{value:env[schedulerBudgetKey]});
 const identity={generation:record.iv,destination:config.guildId,applicationId:config.applicationId,signature:record.iv};
 const current=async()=>{if(!await db.prepare('SELECT 1 WHERE '+eventProviderFence(provider)).bind(identity.signature).first())mismatch();};
 let botId:string|undefined;
 const bot=async()=>{if(!botId){await current();const result=await discordRequest(config,'/users/@me',{method:'GET'},false, env);if(!snow(result.body.id))mismatch();botId=result.body.id as string;}return botId;};
 const call=async(method:string,id?:string,payload?:unknown,preflight?:()=>Promise<void>)=>{
  await current();if(id!==undefined&&!snow(id))mismatch();if(preflight)await preflight();
  try{return (await discordRequest<any>(config,'/guilds/'+identity.destination+'/scheduled-events'+(id?'/'+id:''),{method,...(payload?{body:JSON.stringify(payload)}:{})},false, env)).body;}
  catch(error){if(error instanceof DiscordResponseError&&error.discordStatus===404)return null;throw error;}
 };
 const stamp=(marker:string)=>'[LancerLogin Hours '+marker+']';
 const owned=(value:any,marker:string,creator:string)=>value&&snow(value.id)&&value.guild_id===identity.destination&&value.creator_id===creator&&typeof value.description==='string'&&value.description.endsWith(stamp(marker));
 const find=async(marker:string,id:string|null):Promise<Remote|null>=>{
  const creator=await bot();const value=await call('GET',id??undefined);if(value===null)return null;
  if(id){if(value.id!==id||!owned(value,marker,creator))mismatch();return {id};}
  if(!Array.isArray(value)||value.length>100)mismatch();
  const matches=(value as any[]).filter(item=>typeof item?.description==='string'&&item.description.endsWith(stamp(marker)));
  if(matches.length>1||matches.some(item=>!owned(item,marker,creator)))mismatch();return matches.length?{id:matches[0].id}:null;
 };
 const payload=(marker:string,s:PublicationSnapshot)=>({name:s.title,description:(s.description?s.description+'\n':'')+stamp(marker),scheduled_start_time:s.startsAt,scheduled_end_time:s.endsAt,privacy_level:2,entity_type:3,channel_id:null,entity_metadata:{location:s.location}});
 return {...identity,find,current,
  create:async(marker:string,s:PublicationSnapshot,preflight:()=>Promise<void>)=>{const result=await call('POST',undefined,payload(marker,s),preflight);if(!owned(result,marker,await bot()))mismatch();return result.id as string;},
  update:async(marker:string,s:PublicationSnapshot,remote:Remote,preflight:()=>Promise<void>)=>{const result=await call('PATCH',remote.id,payload(marker,s),preflight);if(!owned(result,marker,await bot())||result.id!==remote.id)mismatch();return remote.id;},
  remove:async(remote:Remote,preflight:()=>Promise<void>)=>{await call('DELETE',remote.id,undefined,preflight);},
 };
}
