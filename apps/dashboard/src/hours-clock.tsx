import { useId } from 'react';
import { resolveCivilTime, type CivilTimeOccurrence } from '@lancerlogin/shared/civil-time';
const offsetLabel = (seconds: number) => `UTC${seconds < 0 ? '−' : '+'}${String(Math.floor(Math.abs(seconds) / 3600)).padStart(2, '0')}:${String(Math.floor(Math.abs(seconds) % 3600 / 60)).padStart(2, '0')}${seconds % 60 ? ':' + String(Math.abs(seconds) % 60).padStart(2, '0') : ''}`;
export function Clock({ label, date, time, zone, occurrence, onTime, onOccurrence, disabled, fixedTime = false }: { label: string; date: string; time: string; zone: string; occurrence?: CivilTimeOccurrence; onTime: (time: string) => void; onOccurrence: (value?: CivilTimeOccurrence) => void; disabled: boolean; fixedTime?: boolean }) {
  const id = useId(); let candidates: ReturnType<typeof resolveCivilTime> = []; let valid = false;
  try { candidates = resolveCivilTime({ date, time, timeZone: zone }); valid = true; } catch { /* incomplete input */ }
  const problem = valid && candidates.length === 0 ? 'This local time does not exist because the clock changes. Choose another time.' : valid && candidates.length > 1 && !occurrence ? 'This time occurs twice. Choose the intended occurrence.' : '';
  return <div className="hours-stack"><label>{label}<input type="time" step="0.001" required value={time} disabled={disabled || fixedTime} aria-invalid={!!problem} aria-describedby={`${id}-help`} onChange={event => { onTime(event.target.value); onOccurrence(undefined); }} /></label><p id={`${id}-help`}>{problem || `${date || 'Choose a service date'} · ${zone}`}</p>
    {candidates.length > 1 && <label>{label} occurrence<select className="ui-native-select" disabled={disabled} value={occurrence ?? ''} onChange={event => onOccurrence(event.target.value as CivilTimeOccurrence)}><option value="">Choose occurrence</option><option value="earlier">First occurrence ({offsetLabel(candidates[0].offsetSeconds)})</option><option value="later">Second occurrence ({offsetLabel(candidates.at(-1)!.offsetSeconds)})</option></select></label>}
  </div>;
}
