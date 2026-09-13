import type {Env} from './index.ts';
import { providerFetch } from './maintenance.ts';
import {HttpError} from './http-error.ts';
import {readDiscordBody} from './discord-platform.ts';
export type PrivateDiscordMessage={content:string;components?:unknown[]};
/** Interaction webhook capability only: never attach or accept a bot token. */
export async function editPrivateInteraction(applicationId:string,token:string,message:PrivateDiscordMessage,expiresAt:number,now=Date.now(), env?: Env){
 if(!/^\d{10,24}$/.test(applicationId)||!/^[A-Za-z0-9._-]{1,2048}$/.test(token)||!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+15*60000)throw new HttpError(400,'Invalid private interaction reply');
 if(typeof message.content!=='string'||message.content.length>2000||message.components&&message.components.length>5)throw new HttpError(400,'Private response exceeds supported limits');
 const body=JSON.stringify({content:message.content,components:message.components??[],allowed_mentions:{parse:[]}});if(new TextEncoder().encode(body).length>16384)throw new HttpError(400,'Private response exceeds supported limits');
 try{
  const response=await providerFetch(env)(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`,{method:'PATCH',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body});
  if(!response.ok)throw new HttpError(502,'Private Discord response was not confirmed');
  await readDiscordBody(response,65536,10000);
 }catch{throw new HttpError(502,'Private Discord response was not confirmed');}
}
