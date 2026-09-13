import { addCalendarDays, elapsedIntegerMinutes, instantToCivil, selectCivilTime } from '@lancerlogin/shared/civil-time';

const base=(import.meta.env.VITE_API_BASE_URL as string|undefined)?.replace(/\/$/,'')??'/api';
export class PublicFailure extends Error { constructor(readonly status=0,readonly retryAfter=0){super('Public request unavailable');} }
export async function publicApi(path:string,body?:string):Promise<any>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000),...(body===undefined?{}:{headers:{'content-type':'application/json'},body})});
  if(!response.ok){void response.body?.cancel().catch(()=>undefined);const raw=response.headers.get('retry-after');const seconds=raw&&/^\d+$/.test(raw)?Number(raw):60;throw new PublicFailure(response.status,response.status===429?Math.min(86400,Math.max(1,Number.isFinite(seconds)?seconds:60)):0);}
  return response.json();
}
export const text=(v:unknown,max=128):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
export type Context={available:true;timeZone:string;today:string;earliestServiceDate:string;reportingDays:number};
export function contextValue(v:any):Context|undefined{
  if(v?.available===false)return undefined;
  if(v?.available!==true||!text(v.timeZone,100)||!Number.isInteger(v.reportingDays)||v.reportingDays<1||v.reportingDays>365)throw Error('Invalid context');
  instantToCivil(Date.now(),v.timeZone);addCalendarDays(v.today,0);addCalendarDays(v.earliestServiceDate,0);if(v.earliestServiceDate>v.today)throw Error('Invalid dates');return v;
}
export type Choice={id:string;label:string;mode?:'event'|'team'|'task';serviceDate?:string;categoryId?:string};
export function choiceValue(v:any,kind:'categories'|'teams'|'events'):Choice{
  if(!v||!text(v.id))throw Error('Invalid choice');
  if(kind==='categories'){if(!text(v.name,256)||!['event','team','task'].includes(v.mode))throw Error('Invalid category');return {id:v.id,label:v.name,mode:v.mode};}
  if(kind==='events'){if(!text(v.title,256)||!text(v.categoryId))throw Error('Invalid event');addCalendarDays(v.serviceDate,0);return {id:v.id,label:v.serviceDate+' · '+v.title,serviceDate:v.serviceDate,categoryId:v.categoryId};}
  if(!text(v.name,256)||typeof v.number!=='string'||v.number.length>128||typeof v.program!=='string'||v.program.length>256)throw Error('Invalid team');return {id:v.id,label:[v.number,v.name,v.program].filter(Boolean).join(' · ')};
}
export type Receipt={id:string;activity_id:string;service_date:string;time_zone:string;start_local:string;end_local:string;end_next_day:number|boolean;start_occurrence:string|null;end_occurrence:string|null;start_ms:number;end_ms:number;start_offset_seconds:number;end_offset_seconds:number;duration_minutes:number;task_notes:string;created_at:string};
export function receiptValue(v:any,p:any):Receipt{
  if(!v||!text(v.id)||!text(v.activity_id)||![0,1,false,true].includes(v.end_next_day)||v.service_date!==p.serviceDate||v.time_zone!==p.expectedTimeZone||v.start_local!==p.startLocal||v.end_local!==p.endLocal||Boolean(v.end_next_day)!==p.endNextDay||v.start_occurrence!==(p.startOccurrence??null)||v.end_occurrence!==(p.endOccurrence??null)||v.task_notes!==p.taskNotes||(p.activityId&&v.activity_id!==p.activityId)||!text(v.created_at,40)||!Number.isFinite(Date.parse(v.created_at)))throw Error('Invalid original receipt');
  if(![v.start_ms,v.end_ms,v.start_offset_seconds,v.end_offset_seconds].every(Number.isSafeInteger))throw Error('Invalid original timing');
  const a=selectCivilTime({date:v.service_date,time:v.start_local,timeZone:'UTC'}),b=selectCivilTime({date:addCalendarDays(v.service_date,Number(Boolean(v.end_next_day))),time:v.end_local,timeZone:'UTC'});
  if(a.epochMilliseconds!==v.start_ms+v.start_offset_seconds*1000||b.epochMilliseconds!==v.end_ms+v.end_offset_seconds*1000||elapsedIntegerMinutes(v.start_ms,v.end_ms)!==v.duration_minutes)throw Error('Invalid duration');return v;
}
