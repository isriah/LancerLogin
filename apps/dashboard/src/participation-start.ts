// The dates the roster shows for when a member's attendance starts, in the organization's time zone, as the API computes
// them (participationStartDate and localDate in apps/api/src/attendance-policy.ts). The UTC date of the moment a member
// was added is a day ahead for an evening addition west of UTC and a day behind for a morning one east of it, so the
// roster showed and pre-filled a date the attendance policy does not use.
//
// This file has no React import, so tests-ts can load it.

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The organization-local calendar date (YYYY-MM-DD) of an instant. An unknown time zone falls back to UTC, as the API's default. */
export function organizationDate(instant: number, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try { formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
    catch { return new Date(instant).toISOString().slice(0, 10); }
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant); const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

/** Today in the organization's time zone: the date a member added now starts on. */
export const organizationToday = (timeZone: string, now = Date.now()) => organizationDate(now, timeZone);

/**
 * The organization-local date a member was added to the roster, which is their participation start when no explicit
 * date is stored. A bare date is already a date; a timestamp without a zone (SQLite's "YYYY-MM-DD HH:MM:SS") is UTC.
 */
export function rosterAddedDate(rosterAddedAt: string | null | undefined, timeZone: string): string {
  if (!rosterAddedAt || datePattern.test(rosterAddedAt)) return rosterAddedAt ?? "";
  const instant = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rosterAddedAt) ? rosterAddedAt : `${rosterAddedAt.replace(" ", "T")}Z`);
  return Number.isFinite(instant) ? organizationDate(instant, timeZone) : rosterAddedAt.slice(0, 10);
}
