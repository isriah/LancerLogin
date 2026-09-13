import {addCalendarDays} from '@lancerlogin/shared/civil-time';
import {publicApi,PublicFailure} from './public-hour-contract';
export {publicApi,PublicFailure};
export type PublicActivity={id:string;title:string;serviceDate:string;mode:'event'|'team'|'task';revision:number};
const obj=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:any,max=128)=>typeof v==='string'&&v.length>0&&v.length<=max;
export const revision=(v:any):v is number=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER;
export function documentationContext(v:any):number|null{if(v?.available===false)return null;if(v?.available!==true||!revision(v.sectionRevision))throw Error('Invalid context');return v.sectionRevision;}
export function documentationActivities(v:any,expected:number){if(!obj(v)||v.sectionRevision!==expected||!Array.isArray(v.activities)||v.activities.length>25||v.next!==null&&!str(v.next))throw Error('Invalid activities');const activities:PublicActivity[]=v.activities.map((a:any)=>{if(!obj(a)||!str(a.id)||!str(a.title,200)||!/^\d{4}-\d{2}-\d{2}$/.test(a.serviceDate)||!['event','team','task'].includes(a.mode)||!revision(a.revision))throw Error('Invalid activity');addCalendarDays(a.serviceDate,0);return a;});if(new Set(activities.map(a=>a.id)).size!==activities.length)throw Error('Duplicate activity');return {activities,next:v.next as string|null};}
export function documentationAck(v:any):string{if(!obj(v)||v.accepted!==true||!str(v.reference)||Object.keys(v).sort().join(',')!=='accepted,reference')throw Error('Unconfirmed acknowledgement');return v.reference;}
