/**
 * A meeting's date as members read it in an email or Discord message: the calendar day in the organization's time zone,
 * written the way the dashboard writes a meeting's date (for example "Nov 20, 2026"). A UTC slice of the timestamp would
 * put an evening meeting west of UTC on the next day. An unknown time zone falls back to UTC.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function memberDateText(timestamp: string, timeZone: string | null | undefined): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const zone = timeZone || "UTC";
  let formatter = formatters.get(zone);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "short", day: "numeric" }); }
    catch { return memberDateText(timestamp, "UTC"); }
    formatters.set(zone, formatter);
  }
  return formatter.format(date);
}
