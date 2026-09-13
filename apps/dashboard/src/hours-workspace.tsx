import { HoursPublication } from './hours-publication';
import { HourCorrections } from './hour-corrections';
import { HourReports } from './hour-reports';
import { HourEntries } from './hour-entries';
import { HourWindows } from './hour-windows';
import { useEffect, useRef, useState } from 'react';
import { instantToCivil } from '@lancerlogin/shared/civil-time';
import { api } from './dashboard-api';
import { HoursChoices } from './hours-choices';
import { HoursEditor } from './hours-editor';
import { identity, pageResult, recordItem, type Kind, type PageResult, type RecordItem } from './hours-contract';

const emptyFilters = { archived: 'false', from: '', to: '', mode: '', categoryId: '', teamId: '' };
const names: Record<Kind, string> = { activities: 'Activities', categories: 'Categories', teams: 'Supported teams' };
function HoursCatalogWorkspace({ accessChecking = false, onOccupied }: { accessChecking?: boolean; onOccupied:(value:boolean)=>void }) {
  const [publication, setPublication] = useState<string>();
  const [kind, setKind] = useState<Kind>('activities'); const [page, setPage] = useState<PageResult<RecordItem>>(); const [cursor, setCursor] = useState('');
  const [filter, setFilter] = useState(emptyFilters); const [appliedFilter, setAppliedFilter] = useState(emptyFilters);
  const [editor, setEditor] = useState<{ record?: RecordItem; key: number }>(); const [timeZone, setTimeZone] = useState('');
  const [working, setBusy] = useState(false); const busy = working || accessChecking; const [locked, setLocked] = useState(false); const [notice, setNotice] = useState<{ text: string; error: boolean; focus?: boolean }>();
  useEffect(() => { onOccupied(working || !!editor || !!publication || locked); }, [working,editor,publication,locked,onOccupied]);
  const noticeRef = useRef<HTMLParagraphElement>(null); const generation = useRef(0); const lock = useRef(false); const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { if (notice?.focus) noticeRef.current?.focus(); }, [notice]);
  const failure = () => { setLocked(true); setNotice({ error: true, focus: true, text: 'The result could not be confirmed. Reload before another change. Check current module access, required fields, references and the organization planning zone. A dated service activity may already exist in archived records. No write is retried automatically.' }); };
  function query(nextCursor = '', filters = appliedFilter) { const values = new URLSearchParams({ archived: filters.archived, limit: '50' }); if (nextCursor) values.set('after', nextCursor); if (kind === 'activities') for (const [key, value] of Object.entries(filters)) if (key !== 'archived' && value) values.set(key, value); return values; }
  async function readPage(nextCursor = '', filters = appliedFilter) { return pageResult(await api<PageResult<RecordItem>>(`/admin/hours/${kind}?${query(nextCursor, filters)}`), item => !!recordItem(item, kind)); }
  async function load(nextCursor = '', filters = appliedFilter) {
    if (lock.current) return; const token = ++generation.current; setBusy(true);
    try { const [result, source] = await Promise.all([readPage(nextCursor, filters), api<{timeZone:string}>('/admin/hours/attendance-sources?limit=1')]); instantToCivil(Date.now(), source.timeZone); if (token !== generation.current) return; setPage(result); setAppliedFilter({ ...filters }); setCursor(nextCursor); setTimeZone(source.timeZone); setLocked(false); setNotice(undefined); }
    catch { if (token === generation.current) failure(); } finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => { setPage(undefined); setCursor(''); void load(); return () => { generation.current++; }; }, [kind]);
  async function refreshZone() { const source = await api<{timeZone:string}>('/admin/hours/attendance-sources?limit=1'); instantToCivil(Date.now(), source.timeZone); setTimeZone(source.timeZone); }
  async function open(record?: RecordItem) {
    if (busy || locked) return; opener.current = document.activeElement as HTMLElement; setBusy(true);
    try { if (!record) await refreshZone(); const detail = record ? recordItem(await api<RecordItem>(`/admin/hours/${kind}/${encodeURIComponent(record.id)}`), kind, true) : undefined; setEditor({ record: detail, key: Date.now() }); setNotice(undefined); }
    catch { failure(); } finally { setBusy(false); }
  }
  function close() { setEditor(undefined); requestAnimationFrame(() => opener.current?.focus()); }
  async function reloadEditor() {
    if (lock.current) return; setBusy(true);
    try { if (!editor?.record) await refreshZone(); const record = editor?.record ? recordItem(await api<RecordItem>(`/admin/hours/${kind}/${encodeURIComponent(editor.record.id)}`), kind, true) : undefined; const current = await readPage(); setPage(current); setCursor(''); setLocked(false); setEditor({ record, key: Date.now() }); setNotice({ error: false, focus: true, text: 'Current server records reloaded. Review the record before submitting a new change; the prior draft was not retried.' }); }
    catch { failure(); } finally { setBusy(false); }
  }
  async function write(body: Record<string, unknown>, target = editor?.record) {
    if (lock.current || busy || locked) return; lock.current = true; setBusy(true);
    try {
      const written = await api<{id:string;revision:number}>(`/admin/hours/${kind}${target ? '/' + encodeURIComponent(target.id) : ''}`, { method: target ? 'PATCH' : 'POST', body: JSON.stringify({ ...body, ...(target ? { revision: target.revision } : {}) }) });
      if (!identity(written?.id) || written.revision !== (target ? target.revision + 1 : 0) || (target && written.id !== target.id)) throw Error('Invalid write response');
      const current = recordItem(await api<RecordItem>(`/admin/hours/${kind}/${encodeURIComponent(written.id)}`), kind, true); if (current.revision !== written.revision) throw Error('Concurrent change');
      const list = await readPage(cursor); setPage(list); if (editor) setEditor({ record: current, key: Date.now() }); setNotice({ error: false, focus: true, text: 'Saved and confirmed from the server. Current records are shown.' });
    } catch { failure(); } finally { lock.current = false; setBusy(false); }
  }
  return <section className="hours-workspace" aria-label="Hour catalogs"><p>Manage activity planning, categories and supported teams.</p>
    <nav className="ui-control-group hours-actions" aria-label="Hour Tracking catalogs">{(Object.keys(names) as Kind[]).map(value => <button key={value} aria-pressed={kind === value} disabled={busy || !!editor || !!publication} onClick={() => { if (value === kind) return; setFilter(emptyFilters); setAppliedFilter(emptyFilters); setKind(value); }}>{names[value]}</button>)}</nav>
    {notice && <p ref={noticeRef} tabIndex={-1} role={notice.error ? 'alert' : 'status'} className="ui-status settings-notice" data-tone={notice.error ? 'error' : 'success'}>{notice.text}</p>}
    {busy && <p role="status">Loading or saving catalog records…</p>}
    {publication ? <HoursPublication activityId={publication} accessChecking={accessChecking} onClose={() => { setPublication(undefined); requestAnimationFrame(() => document.getElementById(`hour-publication-${publication}`)?.focus()); }} /> : editor ? <HoursEditor key={editor.key} kind={kind} record={editor.record} timeZone={timeZone} busy={busy} locked={locked} onSave={body => void write(body)} onClose={close} onReload={() => void reloadEditor()} /> : <>
      <div className="hours-actions"><h2>{names[kind]}</h2><button className="primary-button" disabled={busy || locked || !timeZone} onClick={() => void open()}>Create {kind === 'activities' ? 'activity' : kind === 'categories' ? 'category' : 'supported team'}</button><button disabled={busy} onClick={() => void load()}>Reload catalogs</button></div>
      <form className="ui-card hours-filters" onSubmit={event => { event.preventDefault(); void load('', filter); }}><div className="hours-grid"><label>Record status<select className="ui-native-select" disabled={busy} value={filter.archived} onChange={event => setFilter({ ...filter, archived: event.target.value })}><option value="false">Active</option><option value="true">Archived</option><option value="all">Active and archived</option></select></label>
        {kind === 'activities' && <><label>From service date<input type="date" disabled={busy} value={filter.from} onChange={event => setFilter({ ...filter, from: event.target.value })} /></label><label>Through service date<input type="date" disabled={busy} value={filter.to} min={filter.from} onChange={event => setFilter({ ...filter, to: event.target.value })} /></label><label>Activity mode<select className="ui-native-select" disabled={busy} value={filter.mode} onChange={event => setFilter({ ...filter, mode: event.target.value })}><option value="">All modes</option><option value="event">Event</option><option value="team">Team support</option><option value="task">Task/service</option></select></label></>}
      </div>{kind === 'activities' && <details><summary>Category and team filters</summary><HoursChoices label="Filter category" endpoint="/admin/hours/categories?archived=all" selected={filter.categoryId ? [filter.categoryId] : []} disabled={busy} onChange={ids => setFilter({ ...filter, categoryId: ids[0] ?? '' })} /><HoursChoices label="Filter team" endpoint="/admin/hours/teams?archived=all" selected={filter.teamId ? [filter.teamId] : []} disabled={busy} onChange={ids => setFilter({ ...filter, teamId: ids[0] ?? '' })} /></details>}<div className="hours-actions"><button disabled={busy}>Apply filters</button></div></form>
      {page && <><p>{page.items.length} records on this page. Pages follow stable record order, not chronological order.</p><div className="hours-records">{page.items.map(item => <article className="ui-card hours-row" key={item.id}><div><h3>{item.title ?? (item.number ? `${item.number} · ${item.name}` : item.name)}</h3><p>{item.serviceDate ? `${item.serviceDate} · ` : ''}{item.mode ? `${item.mode === 'team' ? 'Team support' : item.mode === 'task' ? 'Task/service' : 'Event'} · ` : ''}{item.archived ? 'Archived' : 'Active'}</p>{item.planningTimeZone && <p>Planning zone: {item.planningTimeZone}</p>}</div><div className="hours-actions">{kind === 'activities' && item.mode === 'event' && <button id={`hour-publication-${item.id}`} disabled={busy || locked} onClick={() => { opener.current = document.activeElement as HTMLElement; setPublication(item.id); }}>Publication for {item.title}</button>}<button disabled={busy || locked} onClick={() => void open(item)}>Edit {item.title ?? item.name}</button><button disabled={busy || locked} onClick={() => void write({ archived: !item.archived }, item)}>{item.archived ? 'Reopen' : 'Archive'} {item.title ?? item.name}</button></div></article>)}</div>{!page.items.length && <p>No records match these filters.</p>}<div className="hours-actions">{cursor && <button disabled={busy} onClick={() => void load()}>First page</button>}{page.nextCursor && <button disabled={busy || locked} onClick={() => void load(page.nextCursor!)}>Next records page</button>}</div></>}
    </>}
  </section>;
}

export function HoursWorkspace({ accessChecking = false }: { accessChecking?: boolean }) {
  const [view, setView] = useState('catalogs'); const [occupied, setOccupied] = useState(false);
  return <section className="hours-workspace"><div className="page-intro"><h1>Hour Tracking</h1><a href="/submit-hours">Open member submission form</a></div><nav className="hours-actions ui-control-group" aria-label="Hour Tracking workspaces">{[['catalogs','Catalogs'],['entries','Entries'],['windows','Reporting windows'],['corrections','Corrections'],['reports','Reports']].map(([value,label]) => <button key={value} aria-pressed={view===value} disabled={occupied || accessChecking} onClick={() => setView(value)}>{label}</button>)}</nav>{view==='catalogs' ? <HoursCatalogWorkspace accessChecking={accessChecking} onOccupied={setOccupied} /> : view==='entries' ? <HourEntries accessChecking={accessChecking} onOccupied={setOccupied} /> : view==='windows' ? <HourWindows accessChecking={accessChecking} onOccupied={setOccupied} /> : view==='corrections' ? <HourCorrections accessChecking={accessChecking} onOccupied={setOccupied} /> : <HourReports accessChecking={accessChecking} onOccupied={setOccupied} />}</section>;
}
