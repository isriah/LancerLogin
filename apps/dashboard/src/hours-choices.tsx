import { useEffect, useId, useRef, useState } from 'react';
import { api } from './dashboard-api';
import { boundedText, identity, pageResult, type PageResult } from './hours-contract';

export type Choice = { id: string; label: string; selectable?: boolean; active?: boolean; archived?: boolean; mode?: 'event' | 'team' | 'task'; impactDefault?: boolean; serviceDate?: string; startsAt?: string; endsAt?: string | null; title?: string };
export function HoursChoices({ label, endpoint, selected, onChange, multiple = false, max = 1, disabled = false, allowClear = true }: { label: string; endpoint: string; selected: string[]; onChange: (ids: string[], item?: Choice) => void; multiple?: boolean; max?: number; disabled?: boolean; allowClear?: boolean }) {
  const id = useId(); const sequence = useRef(0); const [page, setPage] = useState<PageResult<Choice>>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(false); const [labels, setLabels] = useState<Record<string, string>>({});
  async function load(cursor?: string) {
    const request = ++sequence.current; setBusy(true); setError(false);
    try {
      const raw = await api<PageResult<Choice & { name?: string; number?: string }>>(endpoint + (endpoint.includes('?') ? '&' : '?') + 'limit=50' + (cursor ? '&after=' + encodeURIComponent(cursor) : ''));
      pageResult(raw, item => identity(item?.id) && boundedText(item.label ?? item.name ?? item.title, 256) && [item.selectable, item.active, item.archived].every(value => value === undefined || typeof value === 'boolean') &&
        (!endpoint.includes('/categories') || (['event','team','task'].includes(item.mode ?? '') && typeof item.impactDefault === 'boolean')) &&
        (!endpoint.includes('/responsible-staff') || (typeof item.active === 'boolean' && typeof item.selectable === 'boolean')) &&
        (!endpoint.includes('/attendance-sources') || (boundedText(item.title, 150) && boundedText(item.startsAt, 40) && Number.isFinite(Date.parse(item.startsAt)) && (item.endsAt === null || (boundedText(item.endsAt, 40) && Number.isFinite(Date.parse(item.endsAt)))))));

      const result = { ...raw, items: raw.items.map(item => ({ ...item, label: item.label ?? (item.name ? `${item.number ? item.number + ' · ' : ''}${item.name}` : `${item.serviceDate} · ${item.title}`), selectable: item.selectable ?? (endpoint.includes("archived=all") || !item.archived) })) };
      const known = Object.fromEntries(result.items.map(item => [item.id, item.label]));
      const catalog = /^\/admin\/hours\/(categories|teams)(?:\?|$)/.exec(endpoint)?.[1];
      if (catalog) {
        const missing = selected.filter(value => !known[value]).slice(0, 20);
        const details = await Promise.allSettled(missing.map(value => api<{ id: string; name: string; number?: string }>(`/admin/hours/${catalog}/${encodeURIComponent(value)}`)));
        details.forEach((entry, index) => { if (entry.status === 'fulfilled' && entry.value?.id === missing[index] && boundedText(entry.value.name, 150)) known[entry.value.id] = `${entry.value.number ? entry.value.number + ' · ' : ''}${entry.value.name}`; });
      }
      if (request !== sequence.current) return;
      setPage(result); setLabels(current => ({ ...Object.fromEntries(selected.filter(value => current[value]).map(value => [value, current[value]])), ...known }));
    } catch { if (request === sequence.current) setError(true); } finally { if (request === sequence.current) setBusy(false); }
  }
  useEffect(() => { setPage(undefined); setLabels({}); void load(); return () => { sequence.current++; }; }, [endpoint]);
  return <fieldset className="hours-choices" disabled={disabled}><legend>{label}</legend>
    {error && <p role="alert">Choices could not be loaded. Existing selections are retained.</p>}
    {busy && <p role="status">Loading choices…</p>}
    {multiple ? <><p>{selected.length} of {max} selected.</p>{selected.length > 0 && <ul>{selected.map((value, index) => <li key={value}>{labels[value] ?? `Saved selection ${index + 1} (load its page to see the name)`}<button type="button" onClick={() => onChange(selected.filter(item => item !== value))}>Remove selection {index + 1}</button></li>)}</ul>}
      {page?.items.map(item => <label className="hours-check" key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || error || (!selected.includes(item.id) && (item.selectable === false || selected.length >= max))} onChange={event => onChange(event.target.checked ? [...selected, item.id] : selected.filter(value => value !== item.id), item)} />{item.label}{item.active === false ? ' (inactive)' : item.selectable === false ? ' (unavailable for new selection)' : ''}</label>)}</> : <div className="hours-stack"><label htmlFor={id}>{label}</label><select className="ui-native-select" id={id} disabled={busy || error} value={selected[0] ?? ''} onChange={event => onChange(event.target.value ? [event.target.value] : [], page?.items.find(item => item.id === event.target.value))}>
      <option value="" disabled={!allowClear}>Choose {label.toLowerCase()}</option>{selected[0] && !page?.items.some(item => item.id === selected[0]) && <option value={selected[0]}>{labels[selected[0]] ?? 'Current saved selection'}</option>}{page?.items.map(item => <option key={item.id} value={item.id} disabled={item.selectable === false && !selected.includes(item.id)}>{item.label}{item.archived ? ' (archived)' : ''}</option>)}</select></div>}
    {page?.items.length === 0 && <p>No choices on this page.</p>}
    <div className="hours-actions"><button type="button" disabled={busy} onClick={() => void load()}>Reload {label.toLowerCase()}</button>{page?.nextCursor && <button type="button" disabled={busy || error} onClick={() => void load(page.nextCursor!)}>Next {label.toLowerCase()} page</button>}</div>
  </fieldset>;
}
