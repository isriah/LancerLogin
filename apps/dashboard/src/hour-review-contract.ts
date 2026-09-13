import { addCalendarDays } from '@lancerlogin/shared/civil-time';
import { boundedText, identity, pageResult } from './hours-contract';
import { revision } from './hour-entry-contract';
export type Resolution = {requestId:string;action:'acknowledged'|'dismissed'|'corrected'|'voided';note:string;actorUserId:string;entryId:string|null;entryRevision:number|null;createdAt:string};
export type CorrectionRequest = {id:string;channel:'public'|'discord';attribution:'self_asserted'|'linked_discord';requesterMemberId:string|null;claimedMemberId:string|null;claimedReceiptId:string|null;claimedActivityId:string|null;claimedServiceDate:string|null;message:string;status:'open'|'resolved';revision:0|1;createdAt:string;resolvedAt:string|null;resolution?:Resolution|null};
const timestamp=(v:unknown)=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
export function correctionRequest(v:CorrectionRequest,detail=false){
 if(!v||!identity(v.id)||!['public','discord'].includes(v.channel)||v.attribution!==(v.channel==='public'?'self_asserted':'linked_discord')||![v.requesterMemberId,v.claimedMemberId,v.claimedReceiptId,v.claimedActivityId].every(x=>x===null||identity(x))||!boundedText(v.message,4000)||!v.message.trim()||!timestamp(v.createdAt))throw Error('Invalid request');
 if(v.claimedServiceDate!==null)addCalendarDays(v.claimedServiceDate,0);
 if(v.channel==='discord'&&(v.requesterMemberId===null||v.claimedMemberId!==null)||v.channel==='public'&&v.claimedMemberId===null)throw Error('Invalid attribution');
 if(v.status==='open'){if(v.revision!==0||v.resolvedAt!==null)throw Error('Invalid open request');}else if(v.status!=='resolved'||v.revision!==1||!timestamp(v.resolvedAt)||Date.parse(v.resolvedAt!)<Date.parse(v.createdAt))throw Error('Invalid resolution');
 if(detail){const r=v.resolution;if(v.status==='open'){if(r!==null)throw Error('Unexpected resolution');}else if(!r||r.requestId!==v.id||!['acknowledged','dismissed','corrected','voided'].includes(r.action)||!boundedText(r.note,4000)||!r.note.trim()||!identity(r.actorUserId)||!timestamp(r.createdAt)||r.createdAt!==v.resolvedAt||(r.entryId===null?r.entryRevision!==null:!identity(r.entryId)||!revision(r.entryRevision))||(['corrected','voided'].includes(r.action)&&r.entryId===null))throw Error('Invalid resolution detail');}
 return v;
}
export const requestPage=(raw:Parameters<typeof pageResult<CorrectionRequest>>[0])=>pageResult(raw,v=>!!correctionRequest(v));
export type ReportFilters={from:string;to:string;groupBy:'member'|'activity'|'category'|'team';memberId:string;activityId:string;categoryId:string;teamId:string};
export type Metrics={minutes:number;entryCount:number;distinctParticipants:number};
export type Report={from:string;to:string;groupBy:ReportFilters['groupBy'];teamAttribution:'primary';totals:Metrics;items:(Metrics&{id:string|null})[];nextCursor:string|null};
export function reportPeriod(from:string,to:string){addCalendarDays(from,0);addCalendarDays(to,0);let max='9999-12-31';try{max=addCalendarDays(from,3659);}catch{}if(to<from||to>max)throw Error('Choose at most 3660 service dates');}
export function reportResult(v:Report,filter:ReportFilters){
 const metrics=(m:Metrics)=>m&&[m.minutes,m.entryCount,m.distinctParticipants].every(revision)&&m.distinctParticipants<=m.entryCount;
 if(!v||v.from!==filter.from||v.to!==filter.to||v.groupBy!==filter.groupBy||v.teamAttribution!=='primary'||!metrics(v.totals)||!Array.isArray(v.items)||v.items.length>50||!v.items.every(r=>(r.id===null?v.groupBy==='team':identity(r.id))&&metrics(r)&&r.minutes<=v.totals.minutes&&r.entryCount<=v.totals.entryCount&&r.distinctParticipants<=v.totals.distinctParticipants)||new Set(v.items.map(r=>r.id)).size!==v.items.length||!(v.nextCursor===null||typeof v.nextCursor==='string'&&v.nextCursor.length<=129&&(v.nextCursor==='0'||v.nextCursor.startsWith('1')&&identity(v.nextCursor.slice(1)))))throw Error('Invalid report');
 const cursor=(id:string|null)=>id===null?'0':'1'+id;if(v.nextCursor!==null&&(!v.items.length||v.nextCursor!==cursor(v.items.at(-1)!.id)))throw Error('Invalid report cursor');
 return v;
}
