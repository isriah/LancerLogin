/** Calendar/clock conversion only: callers retain the input zone and chosen instant.
 * No host-local timezone, network access, or accounting policy is consulted.
 */
export type CivilTimeInput = { date: string; time: string; timeZone: string };
export type CivilTimeCandidate = { epochMilliseconds: number; offsetSeconds: number };
export type CivilTimeFields = { date: string; time: string; offsetSeconds: number };
export type CivilTimeOccurrence = 'earlier' | 'later';
export type CivilTimeErrorCode = 'invalid_date' | 'invalid_time' | 'invalid_timezone' | 'invalid_occurrence' | 'nonexistent_time' | 'ambiguous_time' | 'invalid_instant' | 'non_positive_duration' | 'non_integral_duration';
export class CivilTimeError extends Error {
  readonly code: CivilTimeErrorCode;
  constructor(code: CivilTimeErrorCode, message: string) { super(message); this.name = 'CivilTimeError'; this.code = code; }
}
const DAY = 86_400_000;
const FORMATTER_LIMIT = 16;
const formatters = new Map<string, Intl.DateTimeFormat>();

// setUTCFullYear avoids Date.UTC's special interpretation of years 0 through 99.
function utc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): number {
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute, second, millisecond);
  return result.getTime();
}
function dateEpoch(date: string): number {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CivilTimeError('invalid_date', 'Provide a YYYY-MM-DD calendar date');
  const [year, month, day] = date.split('-').map(Number);
  const epoch = utc(year, month, day);
  if (new Date(epoch).toISOString().slice(0, 10) !== date) throw new CivilTimeError('invalid_date', 'Calendar date does not exist');
  return epoch;
}
function timeMilliseconds(time: string): number {
  const match = typeof time === 'string' && /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) throw new CivilTimeError('invalid_time', 'Provide HH:mm with optional seconds and milliseconds');
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3] ?? 0) * 1000 + Number((match[4] ?? '').padEnd(3, '0'));
}
function formatter(zone: string): Intl.DateTimeFormat {
  if (typeof zone !== 'string' || !zone.length || zone.length > 100) throw new CivilTimeError('invalid_timezone', 'Provide a supported time zone');
  const cached = formatters.get(zone);
  if (cached) { formatters.delete(zone); formatters.set(zone, cached); return cached; }
  let result: Intl.DateTimeFormat;
  try {
    // ICU's iso8601 formatter can omit the requested era. Proleptic Gregorian
    // fields plus explicit BC conversion also represent ISO year zero exactly.
    result = new Intl.DateTimeFormat('en-US', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch { throw new CivilTimeError('invalid_timezone', 'Time zone is not supported by this runtime'); }
  if (formatters.size >= FORMATTER_LIMIT) formatters.delete(formatters.keys().next().value!);
  formatters.set(zone, result);
  return result;
}
function representedUTC(format: Intl.DateTimeFormat, instant: number): number {
  const parts = Object.fromEntries(format.formatToParts(instant).map(part => [part.type, part.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return utc(year, Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), new Date(instant).getUTCMilliseconds());
}

/** Format an exact instant with the same padded date/era rules as the resolver.
 * time is always HH:mm:ss.SSS. The caller chooses presentation precision.
 */
export function instantToCivil(epochMilliseconds: number, timeZone: string): CivilTimeFields {
  if (!Number.isSafeInteger(epochMilliseconds) || Math.abs(epochMilliseconds) > 8_640_000_000_000_000) throw new CivilTimeError('invalid_instant', 'Provide exact epoch milliseconds');
  const represented = representedUTC(formatter(timeZone), epochMilliseconds);
  if (!Number.isFinite(represented) || represented < utc(0, 1, 1) || represented >= utc(10000, 1, 1)) throw new CivilTimeError('invalid_date', 'Local date exceeds the four-digit calendar date range');
  const iso = new Date(represented).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 23), offsetSeconds: (represented - epochMilliseconds) / 1000 };
}

/** Return all matching instants in ascending order: gap [], ordinary [one], fold [two].
 * Uses the surrounding-day offset method also used by js-temporal/polyfill:
 * https://github.com/js-temporal/temporal-polyfill/blob/main/lib/ecmascript.ts
 * It assumes timezone data has no intervening offset changes hidden by equal
 * surrounding offsets. Exact roundtrips reject skipped local times, including
 * whole-day skips. Cost: two offset probes and at most two roundtrips.
 */
export function resolveCivilTime(input: CivilTimeInput): CivilTimeCandidate[] {
  const nominal = dateEpoch(input.date) + timeMilliseconds(input.time);
  const format = formatter(input.timeZone);
  const offsets = new Set([-DAY, DAY].map(delta => representedUTC(format, nominal + delta) - (nominal + delta)));
  return [...offsets].map(offset => ({ epochMilliseconds: nominal - offset, offsetSeconds: offset / 1000 }))
    .filter(candidate => representedUTC(format, candidate.epochMilliseconds) === nominal)
    .sort((a, b) => a.epochMilliseconds - b.epochMilliseconds);
}

/** Ordinary times accept either selection; folds require an explicit selection.
 * Gaps are never silently moved. Selection is independent for each endpoint.
 */
export function selectCivilTime(input: CivilTimeInput, occurrence?: CivilTimeOccurrence): CivilTimeCandidate {
  if (occurrence !== undefined && occurrence !== 'earlier' && occurrence !== 'later') throw new CivilTimeError('invalid_occurrence', 'Choose earlier or later');
  const candidates = resolveCivilTime(input);
  if (!candidates.length) throw new CivilTimeError('nonexistent_time', 'This local time does not exist in the selected time zone');
  if (candidates.length > 1 && occurrence === undefined) throw new CivilTimeError('ambiguous_time', 'Choose the earlier or later occurrence of this local time');
  return candidates[occurrence === 'later' ? candidates.length - 1 : 0];
}

/** Add calendar dates, not elapsed zoned hours. The four-digit year contract is
 * preserved; attempts to leave 0000..9999 fail rather than wrap or truncate.
 */
export function addCalendarDays(date: string, days: number): string {
  const epoch = dateEpoch(date);
  if (!Number.isSafeInteger(days)) throw new CivilTimeError('invalid_date', 'Calendar day increment must be an integer');
  const result = epoch + days * DAY;
  if (!Number.isSafeInteger(result) || result < utc(0, 1, 1) || result > utc(9999, 12, 31)) throw new CivilTimeError('invalid_date', 'Result exceeds the four-digit calendar date range');
  return new Date(result).toISOString().slice(0, 10);
}

/** Accounting validation only. Zero/negative time and fractional elapsed minutes
 * are rejected, never rounded. Historical second-level offsets remain exact in
 * the resolver; crossing such an offset change may fail this accounting rule.
 */
export function elapsedIntegerMinutes(startMilliseconds: number, endMilliseconds: number): number {
  if (![startMilliseconds, endMilliseconds].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000)) throw new CivilTimeError('invalid_instant', 'Provide exact epoch milliseconds');
  const difference = endMilliseconds - startMilliseconds;
  if (difference <= 0) throw new CivilTimeError('non_positive_duration', 'End must be after start');
  if (!Number.isSafeInteger(difference) || difference % 60_000 !== 0) throw new CivilTimeError('non_integral_duration', 'Elapsed duration must be a whole number of minutes');
  return difference / 60_000;
}
