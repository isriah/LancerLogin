import { instantToCivil } from '@lancerlogin/shared/civil-time';
export type PublicationProvider = 'google' | 'discord';
export type PublicSnapshot = { title:string; description:string; location:string; serviceDate:string; timeZone:string; startsAt:string|null; endsAt:string|null };
export type PublicationOperation = { generation:number; destination:string; applicationId:string; eventId:string|null; abandoned:boolean; action:'upsert'|'delete'; revision:number; status:'pending'|'processing'|'failed'|'complete'|'review'; phase:'ready'|'create_dispatched'|'known'; error:string|null; attempts:number };
export type PublicationIntent = { provider:PublicationProvider; enabled:boolean; revision:number; generation:number; needsReview:boolean; reviewedActivityRevision:number|null; snapshot:PublicSnapshot|null; target:{ready:false}|{ready:true;key:string;destination:string;applicationId:string}; operations:PublicationOperation[] };
export type PublicationDetail = { activityId:string; activityRevision:number; archived:boolean; providers:PublicationIntent[] };
const object = (v:unknown):v is Record<string,any> => !!v && typeof v==='object' && !Array.isArray(v);
const number = (v:unknown):v is number => Number.isSafeInteger(v) && Number(v)>=0 && Number(v)<Number.MAX_SAFE_INTEGER;
const text = (v:unknown,max:number,required=false):v is string => typeof v==='string' && v.length<=max && (!required || !!v.trim()) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
const invalid = ():never => { throw Error('Invalid publication response'); };
export function publicationDetail(value:unknown, activityId:string):PublicationDetail {
  if (!object(value) || value.activityId!==activityId || !number(value.activityRevision) || typeof value.archived!=='boolean' || !Array.isArray(value.providers) || value.providers.length!==2) return invalid();
  const seen = new Set<string>();
  const providers = value.providers.map((p:unknown):PublicationIntent => {
    if (!object(p) || !['google','discord'].includes(p.provider) || seen.has(p.provider) || typeof p.enabled!=='boolean' || typeof p.needsReview!=='boolean' || !number(p.revision) || !number(p.generation) || p.generation>20 || (p.reviewedActivityRevision!==null && !number(p.reviewedActivityRevision))) return invalid();
    seen.add(p.provider);
    const destination = (d:any) => text(d.destination,1024,true) && text(d.applicationId,24) && (p.provider==='google' ? d.applicationId==='' : /^\d{10,24}$/.test(d.applicationId));
    if (!object(p.target) || typeof p.target.ready!=='boolean' || (p.target.ready && (!/^[a-f0-9]{64}$/.test(p.target.key) || !destination(p.target)))) return invalid();
    let snapshot:PublicSnapshot|null = null;
    if (p.snapshot!==null) {
      if (!object(p.snapshot)) return invalid();
      const s=p.snapshot;
      if (Object.keys(s).length) {
        if (!text(s.title,p.provider==='google'?150:100,true) || !text(s.description,p.provider==='google'?3000:900) || !text(s.location,p.provider==='google'?500:100,p.provider==='discord') || !text(s.timeZone,100,true) || !/^\d{4}-\d\d-\d\d$/.test(s.serviceDate)) return invalid();
        try { if (new Date(s.serviceDate+'T00:00:00Z').toISOString().slice(0,10)!==s.serviceDate) return invalid(); instantToCivil(0,s.timeZone); } catch { return invalid(); }
        if (s.startsAt!==null || s.endsAt!==null) {
          const instant=(v:unknown)=>text(v,40,true) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
          if (!instant(s.startsAt) || !instant(s.endsAt) || Date.parse(s.endsAt)<=Date.parse(s.startsAt) || instantToCivil(Date.parse(s.startsAt),s.timeZone).date!==s.serviceDate || instantToCivil(Date.parse(s.endsAt)-1,s.timeZone).date!==s.serviceDate) return invalid();
        } else if (p.provider==='discord') return invalid();
        snapshot={title:s.title,description:s.description,location:s.location,serviceDate:s.serviceDate,timeZone:s.timeZone,startsAt:s.startsAt,endsAt:s.endsAt};
      }
    }
    if (p.enabled && (!snapshot || !p.generation)) return invalid();
    const keys=new Set<string>();
    if (!Array.isArray(p.operations) || p.operations.length>40) return invalid();
    const operations=p.operations.map((o:unknown):PublicationOperation => {
      if (!object(o) || !number(o.generation) || o.generation<1 || o.generation>p.generation || !destination(o) || !(o.eventId===null || text(o.eventId,128,true)) || typeof o.abandoned!=='boolean' || !['upsert','delete'].includes(o.action) || !number(o.revision) || !['pending','processing','failed','complete','review'].includes(o.status) || !['ready','create_dispatched','known'].includes(o.phase) || !(o.error===null || text(o.error,200)) || !number(o.attempts)) return invalid();
      const key=`${o.generation}:${o.action}`; if (keys.has(key)) return invalid(); keys.add(key);
      return {generation:o.generation,destination:o.destination,applicationId:o.applicationId,eventId:o.eventId,abandoned:o.abandoned,action:o.action,revision:o.revision,status:o.status,phase:o.phase,error:o.error,attempts:o.attempts};
    });
    return {provider:p.provider,enabled:p.enabled,revision:p.revision,generation:p.generation,needsReview:p.needsReview,reviewedActivityRevision:p.reviewedActivityRevision,snapshot,target:p.target.ready?{ready:true,key:p.target.key,destination:p.target.destination,applicationId:p.target.applicationId}:{ready:false},operations};
  });
  return {activityId:value.activityId,activityRevision:value.activityRevision,archived:value.archived,providers};
}
