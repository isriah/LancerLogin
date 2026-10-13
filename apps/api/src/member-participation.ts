export type InactivePeriod = [string, string | null];

/** SQL fragments accept only application-owned expressions, never request text. */
export function inactivePeriodsUpdateSql(nextActive: string): string {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  return `CASE WHEN active = (${nextActive}) THEN inactive_periods_json
    WHEN (${nextActive}) = 0 THEN json_insert(inactive_periods_json, '$[#]', json_array(${now}, NULL))
    ELSE json_set(inactive_periods_json, '$[#-1][1]', ${now}) END`;
}

/** A meeting starting exactly at reactivation is eligible again. */
export function inactiveAtSql(periods: string, startsAt: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${periods}) inactive_period
    WHERE julianday(${startsAt}) >= julianday(json_extract(inactive_period.value, '$[0]'))
    AND (json_extract(inactive_period.value, '$[1]') IS NULL
      OR julianday(${startsAt}) < julianday(json_extract(inactive_period.value, '$[1]'))))`;
}

export function inactiveAt(periodsJson: string | undefined, startsAt: string): boolean {
  const instant = Date.parse(startsAt);
  const periods: InactivePeriod[] = JSON.parse(periodsJson ?? '[]');
  return periods.some(([start, end]) => instant >= Date.parse(start) && (end === null || instant < Date.parse(end)));
}

/** Validate before destructive restore, including ordering and current status. */
export function validateInactivePeriods(value: unknown, active: unknown): void {
  if (typeof value !== 'string' || (active !== 0 && active !== 1)) throw new Error('Invalid member inactivity history');
  const periods: unknown = JSON.parse(value);
  if (!Array.isArray(periods)) throw new Error('Invalid member inactivity history');
  let previousEnd = -Infinity;
  for (const period of periods) {
    if (!Array.isArray(period) || period.length !== 2) throw new Error('Invalid member inactivity history');
    const [start, end] = period;
    const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    if (!timestamp(start) || (end !== null && !timestamp(end))) throw new Error('Invalid member inactivity history');
    const from = Date.parse(start), to = end === null ? Infinity : Date.parse(end);
    if (from < previousEnd || to < from) throw new Error('Invalid member inactivity history');
    previousEnd = to;
  }
  if ((previousEnd === Infinity) !== (active === 0)) throw new Error('Member status does not match inactivity history');
}
