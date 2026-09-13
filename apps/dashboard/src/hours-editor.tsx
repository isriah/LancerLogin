import { Clock } from './hours-clock';
import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { addCalendarDays, instantToCivil, resolveCivilTime, selectCivilTime, type CivilTimeOccurrence } from '@lancerlogin/shared/civil-time';
import { HoursChoices, type Choice } from './hours-choices';
import type { Kind, RecordItem } from './hours-contract';

export function HoursEditor({ kind, record, timeZone, busy, locked, onSave, onClose, onReload }: { kind: Kind; record?: RecordItem; timeZone: string; busy: boolean; locked: boolean; onSave: (body: Record<string, unknown>) => void; onClose: () => void; onReload: () => void }) {
  const [draft, setDraft] = useState<RecordItem>(record ?? { id: '', revision: 0, archived: false, name: '', mode: 'event', impactDefault: false, number: '', organization: '', program: '', historicalDescriptors: '', categoryId: '', serviceDate: '', title: '', description: '', location: '', impactRelevant: false, responsibleStaffIds: [], partnerTeamIds: [] });
  const zone = record?.planningTimeZone ?? timeZone; const heading = useRef<HTMLHeadingElement>(null); const id = useId();
  const initialStart = record?.startsAt ? instantToCivil(Date.parse(record.startsAt), zone) : undefined;
  const initialEnd = record?.endsAt ? instantToCivil(Date.parse(record.endsAt), zone) : undefined;
  const initialOccurrence = (instant?: string | null): CivilTimeOccurrence | undefined => { if (!instant) return; const civil = instantToCivil(Date.parse(instant), zone); const choices = resolveCivilTime({ ...civil, timeZone: zone }); return choices.length > 1 ? choices[0].epochMilliseconds === Date.parse(instant) ? 'earlier' : 'later' : undefined; };
  const [timed, setTimed] = useState(!!record?.startsAt); const [start, setStart] = useState(initialStart?.time ?? ''); const [end, setEnd] = useState(initialEnd?.time ?? '');
  const [nextMidnight, setNextMidnight] = useState(!!initialEnd && initialEnd.date !== record?.serviceDate); const [startOccurrence, setStartOccurrence] = useState(initialOccurrence(record?.startsAt)); const [endOccurrence, setEndOccurrence] = useState(initialOccurrence(record?.endsAt));
  const [sourceFrom, setSourceFrom] = useState(''); const [sourceThrough, setSourceThrough] = useState('');
  const [sourceNeedsTiming, setSourceNeedsTiming] = useState(false); const blocked = busy || locked;
  useEffect(() => { heading.current?.focus(); }, []);
  const field = (key: keyof RecordItem, label: string, max: number, multiline = false, required = false) => <div className="hours-stack"><label htmlFor={`${id}-field-${key}`}>{label}</label>{multiline ? <textarea id={`${id}-field-${key}`} disabled={blocked} maxLength={max} value={String(draft[key] ?? '')} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /> : <input id={`${id}-field-${key}`} disabled={blocked} required={required} maxLength={max} value={String(draft[key] ?? '')} onChange={event => setDraft({ ...draft, [key]: event.target.value })} />}</div>;
  let endDate = draft.serviceDate ?? ''; try { if (nextMidnight && endDate) endDate = addCalendarDays(endDate, 1); } catch { endDate = ''; }
  let planning: { startsAt: string | null; endsAt: string | null } = { startsAt: null, endsAt: null }; let timingError = '';
  if (kind === 'activities' && timed) {
    try {
      const serviceDate = draft.serviceDate ?? ''; const startValue = selectCivilTime({ date: serviceDate, time: start, timeZone: zone }, startOccurrence).epochMilliseconds;
      const endValue = selectCivilTime({ date: nextMidnight ? addCalendarDays(serviceDate, 1) : serviceDate, time: nextMidnight ? '00:00' : end, timeZone: zone }, endOccurrence).epochMilliseconds;
      if (endValue <= startValue) throw Error('End must follow start.');
      planning = { startsAt: new Date(startValue).toISOString(), endsAt: new Date(endValue).toISOString() };
    } catch { timingError = 'Choose valid start and end times, with an occurrence for each repeated time. End must follow start within this service date.'; }
  }
  let sourceEndpoint = '/admin/hours/attendance-sources'; let sourceRangeError = false;
  try { const query = new URLSearchParams(); if (sourceFrom) query.set('from', new Date(selectCivilTime({ date: sourceFrom, time: '00:00', timeZone: zone }, 'earlier').epochMilliseconds).toISOString()); if (sourceThrough) query.set('to', new Date(selectCivilTime({ date: addCalendarDays(sourceThrough, 1), time: '00:00', timeZone: zone }, 'earlier').epochMilliseconds).toISOString()); if (sourceFrom && sourceThrough && sourceFrom > sourceThrough) throw Error('Reversed dates'); sourceEndpoint += '?' + query; } catch { sourceRangeError = true; }
  function selectSource(ids: string[], item?: Choice) {
    try {
    setDraft(current => ({ ...current, sourceMeetingId: ids[0] ?? null }));
    if (!item?.startsAt) { setSourceNeedsTiming(false); return; }
    const first = instantToCivil(Date.parse(item.startsAt), zone); const last = item.endsAt ? instantToCivil(Date.parse(item.endsAt), zone) : undefined;
    const fits = !!last && (last.date === first.date || (last.date === addCalendarDays(first.date, 1) && last.time === '00:00:00.000'));
    setDraft(current => ({ ...current, sourceMeetingId: item.id, title: item.title, serviceDate: first.date })); setTimed(true); setStart(first.time); setEnd(last?.time ?? ''); setNextMidnight(!!last && fits && last.date !== first.date); setSourceNeedsTiming(!fits); setStartOccurrence(initialOccurrence(item.startsAt)); setEndOccurrence(initialOccurrence(item.endsAt));
    } catch { setSourceNeedsTiming(true); }
  }
  function submit(event: FormEvent) {
    event.preventDefault(); if (blocked || timingError || sourceNeedsTiming) return;
    const body: Record<string, unknown> = kind === 'categories' ? { name: draft.name, mode: draft.mode, impactDefault: draft.impactDefault } : kind === 'teams' ? { name: draft.name, number: draft.number, organization: draft.organization, program: draft.program, historicalDescriptors: draft.historicalDescriptors } : { categoryId: draft.categoryId, teamId: draft.mode === 'team' ? draft.teamId : null, serviceDate: draft.serviceDate, ...(draft.title?.trim() ? { title: draft.title } : {}), description: draft.description, location: draft.location, impactRelevant: draft.impactRelevant, responsibleStaffIds: draft.responsibleStaffIds, partnerTeamIds: draft.partnerTeamIds, ...planning, ...(!record ? { expectedTimeZone: zone } : {}), ...(!record && draft.sourceMeetingId ? { sourceMeetingId: draft.sourceMeetingId } : {}) };
    onSave(body);
  }
  return <section className="ui-card hours-editor" aria-labelledby={`${id}-title`}><h2 ref={heading} tabIndex={-1} id={`${id}-title`}>{record ? 'Edit' : 'Create'} {kind === 'activities' ? 'activity' : kind === 'categories' ? 'category' : 'supported team'}</h2>
    {record?.archived && <p className="ui-status" data-tone="warning">Archived record. Editing preserves its history; reopen separately when needed.</p>}
    <form className="hours-stack" onSubmit={submit}>
      {kind === 'categories' && <>{field('name', 'Category name', 100, false, true)}<label>Entry mode<select className="ui-native-select" disabled={blocked} value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value as RecordItem['mode'] })}><option value="event">Event</option><option value="team">Team support</option><option value="task">Task/service</option></select></label><p>Mode cannot change once any activity uses this category, including archived activities.</p><label className="hours-check"><input type="checkbox" disabled={blocked} checked={draft.impactDefault} onChange={event => setDraft({ ...draft, impactDefault: event.target.checked })} />Impact relevance by default for new activities</label><p>Changing the default does not rewrite existing activities.</p></>}
      {kind === 'teams' && <>{field('name', 'Team name', 150, false, true)}<div className="hours-grid">{field('number', 'Team number', 32)}{field('organization', 'Organization', 200)}{field('program', 'Program', 100)}</div><p>Team numbers are text, so leading zeroes are preserved.</p>{field('historicalDescriptors', 'Historical descriptors', 4000, true)}<p>Staff-entered history does not establish verification or an award claim.</p></>}
      {kind === 'activities' && <>
        <HoursChoices label="Category" endpoint="/admin/hours/categories" selected={draft.categoryId ? [draft.categoryId] : []} disabled={blocked || !!record} allowClear={false} onChange={(ids, item) => { setSourceNeedsTiming(false); setDraft({ ...draft, categoryId: ids[0], mode: item?.mode, teamId: null, sourceMeetingId: null, impactRelevant: item?.impactDefault ?? false }); }} />
        {draft.mode === 'team' && <HoursChoices label="Supported team" endpoint="/admin/hours/teams" selected={draft.teamId ? [draft.teamId] : []} disabled={blocked || !!record} allowClear={false} onChange={ids => setDraft({ ...draft, teamId: ids[0] })} />}
        {draft.mode !== 'event' && <p>One activity per category and service date{draft.mode === 'team' ? ', for this supported team' : ''}. If it already exists, find and reopen the original, including archived records. Category, team and service date cannot change later.</p>}
        {!record && draft.mode === 'event' && <details><summary>Reuse attendance planning details (optional)</summary><p>Copy only the title, date and planning times. The records remain separate and attendance is unchanged.</p><div className="hours-grid"><label>Source from date<input type="date" disabled={blocked} value={sourceFrom} onChange={event => setSourceFrom(event.target.value)} /></label><label>Source through date<input type="date" disabled={blocked} value={sourceThrough} onChange={event => setSourceThrough(event.target.value)} /></label></div><p>Source dates use {zone}.</p>{sourceRangeError ? <p role="alert">Choose an ordered date range whose midnight exists in this planning zone, or clear the range.</p> : <HoursChoices label="Attendance source" endpoint={sourceEndpoint} selected={draft.sourceMeetingId ? [draft.sourceMeetingId] : []} onChange={selectSource} disabled={blocked} />}</details>}
        {record?.sourceMeetingId && <section><h3>Attendance reference</h3><p>{record.sourceSnapshot?.title ?? 'Saved attendance source'} · {record.sourceState === 'changed' ? 'Source has changed; saved copy remains unchanged.' : record.sourceState === 'unavailable' ? 'Source unavailable; saved copy remains available.' : 'Source matches the saved copy.'}</p></section>}
        <label>Service date<input type="date" required disabled={blocked || (!!record && draft.mode !== 'event')} value={draft.serviceDate} onChange={event => { setDraft({ ...draft, serviceDate: event.target.value }); setStartOccurrence(undefined); setEndOccurrence(undefined); }} /></label>
        {field('title', 'Activity title', 150)}<p>Leave a new title blank to use the category and date.</p>{field('description', 'Description', 4000, true)}{field('location', 'Location', 300)}
        <label className="hours-check"><input type="checkbox" checked={draft.impactRelevant} disabled={blocked} onChange={event => setDraft({ ...draft, impactRelevant: event.target.checked })} />Impact relevant</label>
        <fieldset disabled={blocked}><legend>Optional planning times</legend><p>Planning zone: <strong>{zone}</strong>. These are planning metadata, not recorded volunteer hours.</p><label className="hours-check"><input type="checkbox" checked={timed} onChange={event => { setTimed(event.target.checked); setSourceNeedsTiming(false); }} />Set planning times</label>
          {timed && <><div className="hours-grid"><Clock label="Start time" date={draft.serviceDate ?? ''} time={start} zone={zone} occurrence={startOccurrence} disabled={blocked} onTime={value => { setStart(value); setSourceNeedsTiming(false); }} onOccurrence={setStartOccurrence} /><Clock label="End time" date={endDate} time={nextMidnight ? '00:00' : end} zone={zone} occurrence={endOccurrence} disabled={blocked} fixedTime={nextMidnight} onTime={value => { setEnd(value); setSourceNeedsTiming(false); }} onOccurrence={setEndOccurrence} /></div><label className="hours-check"><input type="checkbox" checked={nextMidnight} onChange={event => { setNextMidnight(event.target.checked); setEndOccurrence(undefined); setSourceNeedsTiming(false); }} />End exactly at the next local midnight</label></>}
          {(timingError || sourceNeedsTiming) && <p role="alert">{sourceNeedsTiming ? 'The source spans more than this date or lacks an end time. Choose explicit per-day times, or explicitly turn planning times off; nothing is clipped automatically.' : timingError}</p>}
        </fieldset>
        <HoursChoices label="Responsible staff" endpoint={'/admin/hours/responsible-staff' + (record ? '?activityId=' + encodeURIComponent(record.id) : '')} selected={draft.responsibleStaffIds ?? []} multiple max={10} disabled={blocked} onChange={ids => setDraft({ ...draft, responsibleStaffIds: ids })} />
        <p>Accounts without a display identity need an Admin to add a roster link or local username in Access settings. Existing inactive or unnamed selections may be retained.</p>
        <HoursChoices label="Partner teams" endpoint="/admin/hours/teams" selected={draft.partnerTeamIds ?? []} multiple max={20} disabled={blocked} onChange={ids => setDraft({ ...draft, partnerTeamIds: ids })} />
      </>}
      <div className="hours-actions"><button className="primary-button" disabled={blocked || !!timingError || sourceNeedsTiming || (kind === 'activities' && (!draft.categoryId || (draft.mode === 'team' && !draft.teamId)))}>Save {kind === 'activities' ? 'activity' : kind === 'categories' ? 'category' : 'team'}</button><button type="button" disabled={busy} onClick={onClose}>Close editor</button>{locked && <button type="button" disabled={busy} onClick={onReload}>Reload current record</button>}</div>
    </form>
  </section>;
}
