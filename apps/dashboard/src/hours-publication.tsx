import { useEffect, useId, useRef, useState } from 'react';
import { addCalendarDays, instantToCivil, resolveCivilTime, selectCivilTime, type CivilTimeOccurrence } from '@lancerlogin/shared/civil-time';
import { api } from './dashboard-api';
import { Clock } from './hours-clock';
import { recordItem, type RecordItem } from './hours-contract';
import { publicationDetail, type PublicationDetail, type PublicationIntent, type PublicationOperation } from './hour-publication-contract';

const names = { google:'Google Calendar', discord:'Discord' };
type Planning = { date:string; zone:string };
function ProviderPublication({ intent, detail, planning, blocked, onSave, onRetry }: { intent:PublicationIntent; detail:PublicationDetail; planning:Planning; blocked:boolean; onSave:(body:Record<string,unknown>)=>void; onRetry:(operation:PublicationOperation)=>void }) {
  const name=names[intent.provider], snapshot=intent.snapshot, id=useId();
  const [enabled,setEnabled]=useState(intent.enabled), [title,setTitle]=useState(snapshot?.title??''), [description,setDescription]=useState(snapshot?.description??''), [location,setLocation]=useState(snapshot?.location??''), [reviewed,setReviewed]=useState(false);
  const civil=(instant?:string|null)=>instant?instantToCivil(Date.parse(instant),planning.zone):undefined;
  const occurrence=(instant?:string|null):CivilTimeOccurrence|undefined=>{if (!instant) return; const c=civil(instant)!;const choices=resolveCivilTime({...c,timeZone:planning.zone});return choices.length>1?choices[0].epochMilliseconds===Date.parse(instant)?'earlier':'later':undefined;};
  // Only previously reviewed public content is reused. Private activity fields never seed this form.
  const savedStart=civil(snapshot?.startsAt),savedEnd=civil(snapshot?.endsAt);
  const fitsSavedDate=snapshot?.serviceDate===planning.date && snapshot.timeZone===planning.zone;
  const [timed,setTimed]=useState(intent.provider==='discord'||!!snapshot?.startsAt),[start,setStart]=useState(fitsSavedDate?savedStart?.time??'':''),[end,setEnd]=useState(fitsSavedDate?savedEnd?.time??'':'');
  const [midnight,setMidnight]=useState(!!fitsSavedDate&&!!savedEnd&&savedEnd.date!==planning.date),[startOccurrence,setStartOccurrence]=useState(occurrence(fitsSavedDate?snapshot?.startsAt:null)),[endOccurrence,setEndOccurrence]=useState(occurrence(fitsSavedDate?snapshot?.endsAt:null));
  let startsAt:string|null=null,endsAt:string|null=null,timingError='';
  if (enabled && timed) try {
    const first=selectCivilTime({date:planning.date,time:start,timeZone:planning.zone},startOccurrence).epochMilliseconds;
    const last=selectCivilTime({date:midnight?addCalendarDays(planning.date,1):planning.date,time:midnight?'00:00':end,timeZone:planning.zone},endOccurrence).epochMilliseconds;
    if (last<=first || (intent.provider==='discord'&&first<=Date.now())) throw Error();
    startsAt=new Date(first).toISOString();endsAt=new Date(last).toISOString();
  } catch { timingError=`Choose valid ordered times on this service date and each repeated occurrence.${intent.provider==='discord'?' Discord start must be in the future.':''}`; }
  const invalidText=!title.trim() || (intent.provider==='discord'&&!location.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title+description+location);
  const cannotPublish=detail.archived || !intent.target.ready;
  const change=(action:()=>void)=>{setReviewed(false);action();};
  return <section className="ui-card hours-stack hours-publication-provider" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{name}</h3><p>Saved publication: <strong>{intent.enabled?'On':'Off'}</strong>. {intent.needsReview?'Review required: the activity, access or provider connection changed.':'Publication is separate from saved hours and Attendance.'}</p>
    {intent.target.ready?<p className="hours-publication-text">Current {intent.provider==='google'?'calendar':'server'}: <strong>{intent.target.destination}</strong>{intent.target.applicationId&&<> · Application: {intent.target.applicationId}</>}</p>:<p className="ui-status" data-tone="warning">No verified {name} destination is ready. Ask an Admin to review Connections. Existing destinations and cleanup remain below.</p>}
    <form className="hours-stack" onSubmit={event=>{event.preventDefault();if(blocked || (enabled&&(cannotPublish||!reviewed||invalidText||timingError)))return;onSave({revision:intent.revision,activityRevision:detail.activityRevision,enabled,...(enabled&&intent.target.ready?{targetKey:intent.target.key,snapshot:{title:title.trim(),description:description.trim(),location:location.trim(),startsAt,endsAt}}:{})});}}>
      <label className="hours-check"><input type="checkbox" disabled={blocked || (!enabled&&cannotPublish)} checked={enabled} onChange={event=>change(()=>setEnabled(event.target.checked))} />Publish to {name}</label>
      {enabled?<fieldset className="hours-stack" disabled={blocked || cannotPublish}><legend>Public {name} snapshot</legend><p>Only these reviewed fields will be published. Private activity notes, people and hour records are not included.</p>
        <label>Public {name} title<input required maxLength={intent.provider==='google'?150:100} value={title} onChange={event=>change(()=>setTitle(event.target.value))} /></label>
        <label>Public {name} description<textarea maxLength={intent.provider==='google'?3000:900} value={description} onChange={event=>change(()=>setDescription(event.target.value))} /></label>
        <label>Public {name} location<input required={intent.provider==='discord'} maxLength={intent.provider==='google'?500:100} value={location} onChange={event=>change(()=>setLocation(event.target.value))} /></label>
        <p>Service date: {planning.date} · Planning zone: {planning.zone}</p>
        {intent.provider==='google'?<label className="hours-check"><input type="checkbox" checked={timed} onChange={event=>change(()=>setTimed(event.target.checked))} />Set Google Calendar publication times</label>:<p>Discord requires explicit future start/end times and a location.</p>}
        {!timed&&<p>Google Calendar will publish an all-day event on {planning.date}.</p>}
        {timed&&<div role="group" aria-label={`${name} publication times`} aria-describedby={timingError?`${id}-timing`:undefined} className="hours-stack"><div className="hours-grid"><Clock label={`${name} start time`} date={planning.date} time={start} zone={planning.zone} occurrence={startOccurrence} disabled={blocked||cannotPublish} onTime={v=>change(()=>setStart(v))} onOccurrence={v=>change(()=>setStartOccurrence(v))} /><Clock label={`${name} end time`} date={midnight?addCalendarDays(planning.date,1):planning.date} time={midnight?'00:00':end} zone={planning.zone} occurrence={endOccurrence} disabled={blocked||cannotPublish} fixedTime={midnight} onTime={v=>change(()=>setEnd(v))} onOccurrence={v=>change(()=>setEndOccurrence(v))} /></div><label className="hours-check"><input type="checkbox" checked={midnight} onChange={event=>change(()=>{setMidnight(event.target.checked);setEndOccurrence(undefined);})} />End {name} publication at the next local midnight</label></div>}
        {timingError&&<p id={`${id}-timing`} role="alert">{timingError}</p>}
        <label className="hours-check"><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)} />I reviewed this public content and the current {name} destination</label>
      </fieldset>:<p>Saving Off queues deletion of this provider’s owned event. Cleanup may remain pending after publication is off.</p>}
      <div className="hours-actions"><button className={enabled?'primary-button':'danger-button'} disabled={blocked || (enabled&&(cannotPublish||!reviewed||invalidText||!!timingError)) || (!enabled&&!intent.enabled)} aria-describedby={timingError?`${id}-timing`:undefined}>{enabled?`Save ${name} publication`:`Turn off ${name} publication`}</button></div>
    </form>
    <div className="hours-stack"><h4>Delivery and cleanup</h4><p>On does not mean delivered. Reload to check delivery; failed delivery may be retried by the server. Review-required work waits for review.</p>{!intent.operations.length&&<p>No publication has been queued.</p>}
      {intent.operations.map(operation=>{
        const originalTarget=intent.target.ready&&intent.target.destination===operation.destination&&intent.target.applicationId===operation.applicationId;
        const uncertain=operation.phase==='create_dispatched'&&!operation.eventId;
        const retryable=['failed','review'].includes(operation.status)&&originalTarget&&!uncertain&&(operation.action==='delete'||(intent.enabled&&!intent.needsReview&&!operation.abandoned&&operation.generation===intent.generation&&!detail.archived));
        return <article className="hours-stack hours-publication-operation" key={`${operation.generation}:${operation.action}`}><h5>Generation {operation.generation} · {operation.action==='delete'?'Delete owned event':'Publish event'} · {operation.status==='review'?'Review required':operation.status}</h5>
          <p className="hours-publication-text">Original destination: {operation.destination}{operation.applicationId&&<> · Application: {operation.applicationId}</>}{operation.abandoned?' · Previous publication generation':''}</p>
          {operation.eventId&&<p className="hours-publication-text">Owned event ID: {operation.eventId}</p>}{operation.error&&<p>{operation.error}</p>}
          {operation.status!=='complete'&&(!originalTarget||uncertain)&&<p className="ui-status" data-tone="warning">{uncertain?'Creation is uncertain. Review provider ownership before further action.':'The current connection does not match this original destination. An Admin must review the original provider resource; it cannot be retargeted.'}</p>}
          {retryable&&<button disabled={blocked} onClick={()=>onRetry(operation)}>Retry {name} {operation.action==='delete'?'cleanup':'delivery'} generation {operation.generation}</button>}
        </article>;
      })}</div>
  </section>;
}

export function HoursPublication({activityId,accessChecking,onClose}:{activityId:string;accessChecking:boolean;onClose:()=>void}) {
  const [current,setCurrent]=useState<{detail:PublicationDetail;planning:Planning;key:number}>(),[busy,setBusy]=useState(false),[locked,setLocked]=useState(false),[notice,setNotice]=useState<{error:boolean;text:string}>();
  const heading=useRef<HTMLHeadingElement>(null),message=useRef<HTMLParagraphElement>(null),operation=useRef(false),sequence=useRef(0),accessVersion=useRef(0),viewVersion=useRef(0);
  const endpoint=`/admin/hours/activities/${encodeURIComponent(activityId)}/publications`;
  useEffect(()=>{heading.current?.focus();return()=>{sequence.current++;};},[]);
  useEffect(()=>{if(notice)message.current?.focus();},[notice]);
  useEffect(()=>{if(accessChecking){accessVersion.current++;setLocked(true);}},[accessChecking]);
  const fail=()=>{setLocked(true);setNotice({error:true,text:'The current result could not be confirmed. Reload publication before another change. Check access and provider settings; no write is repeated automatically.'});};
  async function read() {
    const [raw,record]=await Promise.all([api<unknown>(endpoint),api<RecordItem>(`/admin/hours/activities/${encodeURIComponent(activityId)}`)]);
    const detail=publicationDetail(raw,activityId),activity=recordItem(record,'activities',true);
    if(activity.id!==activityId||activity.mode!=='event'||activity.revision!==detail.activityRevision||activity.archived!==detail.archived)throw Error('Activity changed');
    return {detail,planning:{date:activity.serviceDate!,zone:activity.planningTimeZone!},key:++viewVersion.current};
  }
  async function load(initial=false) {
    if((operation.current&&!initial)||accessChecking)return;operation.current=true;setBusy(true);const token=++sequence.current,accessToken=accessVersion.current;
    try{const result=await read();if(token!==sequence.current)return;setCurrent(result);setLocked(accessToken!==accessVersion.current);if(!initial)setNotice({error:false,text:'Current publication and activity loaded. Review public fields and destinations before saving; prior drafts were discarded.'});}
    catch{if(token===sequence.current)fail();}finally{operation.current=false;if(token===sequence.current)setBusy(false);}
  }
  useEffect(()=>{void load(true);},[activityId]);
  async function write(intent:PublicationIntent,body:Record<string,unknown>,retry?:PublicationOperation) {
    if(operation.current||busy||locked||accessChecking||!current)return;operation.current=true;setBusy(true);const token=++sequence.current;
    try{
      const saved=publicationDetail(await api<unknown>(`${endpoint}/${intent.provider}${retry?'/retry':''}`,{method:retry?'POST':'PUT',body:JSON.stringify(body)}),activityId);
      const savedIntent=saved.providers.find(p=>p.provider===intent.provider)!;
      if(!retry&&body.enabled){const content=body.snapshot as Record<string,unknown>;if(!savedIntent.snapshot||Object.entries(content).some(([key,value])=>savedIntent.snapshot![key as keyof typeof savedIntent.snapshot]!==value))throw Error('Unconfirmed content');}
      if(saved.activityRevision!==current.detail.activityRevision || (retry?savedIntent.operations.find(o=>o.generation===retry.generation&&o.action===retry.action)?.revision!==retry.revision+1:savedIntent.revision!==intent.revision+1||savedIntent.enabled!==body.enabled))throw Error('Unconfirmed revision');
      const fresh=await read();if(token!==sequence.current)return;
      if(fresh.detail.activityRevision!==saved.activityRevision||fresh.detail.providers.find(p=>p.provider===intent.provider)!.revision!==savedIntent.revision)throw Error('Concurrent publication change');
      setCurrent(fresh);setNotice({error:false,text:'Publication request saved and confirmed. Delivery and cleanup status are shown separately. Unsaved public drafts were discarded.'});
    }catch{if(token===sequence.current)fail();}finally{operation.current=false;if(token===sequence.current)setBusy(false);}
  }
  return <section className="hours-stack" aria-label="Event publication"><h2 ref={heading} tabIndex={-1}>Event publication</h2><p>Review Google Calendar and Discord independently. Neither is enabled by creating an activity. Saving or reloading replaces unsaved public drafts in this panel.</p>
    {notice&&<p ref={message} tabIndex={-1} role={notice.error?'alert':'status'} className="ui-status" data-tone={notice.error?'error':'success'}>{notice.text}</p>}
    {accessChecking&&<p role="status">Checking current module access…</p>}{locked&&!notice&&<p role="status">Access was refreshed. Reload publication before making changes.</p>}{busy&&<p role="status">Loading or saving publication…</p>}
    <div className="hours-actions"><button disabled={busy||accessChecking} onClick={()=>void load()}>Reload publication</button><button disabled={busy} onClick={onClose}>Close publication</button></div>
    {current?.detail.archived&&<p className="ui-status" data-tone="warning">This event is archived. Publication cannot be enabled. Review any remaining owned cleanup below.</p>}
    {current&&current.detail.providers.map(intent=><ProviderPublication key={`${current.key}:${intent.provider}`} intent={intent} detail={current.detail} planning={current.planning} blocked={busy||locked||accessChecking} onSave={body=>void write(intent,body)} onRetry={o=>void write(intent,{generation:o.generation,action:o.action,revision:o.revision},o)} />)}
  </section>;
}
