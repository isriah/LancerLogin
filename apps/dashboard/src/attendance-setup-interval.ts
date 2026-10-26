/** A short rehearsal window containing now, wholly within the organization's day. */
export function attendanceSetupInterval(now: number, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = formatter.format(now);
  const sameDay = (instant: number) => formatter.format(instant) === today;
  let start = Math.floor((now - 5 * 60_000) / 60_000) * 60_000;
  if (!sameDay(start)) {
    let outside = start, inside = now;
    while (inside - outside > 1) { const middle = Math.floor((inside + outside) / 2); if (sameDay(middle)) inside = middle; else outside = middle; }
    start = inside;
  }
  let end = start + 60 * 60_000;
  if (!sameDay(end)) {
    let inside = now, outside = end;
    while (outside - inside > 1) { const middle = Math.floor((inside + outside) / 2); if (sameDay(middle)) inside = middle; else outside = middle; }
    end = inside;
  }
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() };
}
