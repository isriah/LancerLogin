/**
 * What disabling Attendance leaves on Google Calendar and Discord, for the confirmation in Settings > Modules. While
 * Attendance is disabled nothing is sent to either, so event removals that have not gone out wait, and disabling itself
 * removes no event of a current or upcoming meeting. The Worker counts both when the confirmation asks
 * (GET /platform/modules?disable=attendance), only for providers with a saved connection.
 */
type Provider = "google_calendar" | "discord";
type Counts = { readonly waitingRemovals: number; readonly upcomingEvents: number };
export type AttendanceDisableCalendar = Readonly<Partial<Record<Provider, Counts>>>;

const providers: readonly Provider[] = ["google_calendar", "discord"];
const names: Record<Provider, string> = { google_calendar: "Google Calendar", discord: "Discord" };
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

/** The counts in that answer; undefined when it carries none or they are malformed. */
export function readAttendanceDisableCalendar(value: unknown): AttendanceDisableCalendar | undefined {
  const calendar = value && typeof value === "object" ? (value as { attendanceDisableCalendar?: unknown }).attendanceDisableCalendar : undefined;
  if (!calendar || typeof calendar !== "object" || Array.isArray(calendar)) return undefined;
  const result: Partial<Record<Provider, Counts>> = {};
  for (const provider of providers) {
    const item = (calendar as Record<string, unknown>)[provider];
    if (item === undefined) continue;
    const { waitingRemovals, upcomingEvents } = (item && typeof item === "object" ? item : {}) as { waitingRemovals?: unknown; upcomingEvents?: unknown };
    if (!count(waitingRemovals) || !count(upcomingEvents)) return undefined;
    result[provider] = { waitingRemovals: Number(waitingRemovals), upcomingEvents: Number(upcomingEvents) };
  }
  return result;
}

/** "3 Google Calendar events and 1 Discord event", with the total, from one count per provider. */
function events(calendar: AttendanceDisableCalendar, key: keyof Counts) {
  const shown = providers.filter((provider) => (calendar[provider]?.[key] ?? 0) > 0);
  const total = shown.reduce((sum, provider) => sum + calendar[provider]![key], 0);
  const text = shown.map((provider) => { const value = calendar[provider]![key]; return `${value} ${names[provider]} ${value === 1 ? "event" : "events"}`; }).join(" and ");
  return { shown, total, text };
}

/**
 * The confirmation's sentences about the calendars, none when nothing is left behind, so the confirmation then reads as
 * it always has. Plural when there is more than one event in all.
 */
export function attendanceDisableCalendarText(calendar: AttendanceDisableCalendar | undefined): string[] {
  if (!calendar) return [];
  const sentences: string[] = [];
  const waiting = events(calendar, "waitingRemovals");
  if (waiting.total) {
    const one = waiting.total === 1;
    sentences.push(`${waiting.text} ${one ? "is" : "are"} waiting to be removed. ${one ? "It is" : "They are"} removed if Attendance is enabled again within 7 days; after that ${one ? "it" : "they"} must be deleted by hand.`);
  }
  const upcoming = events(calendar, "upcomingEvents");
  if (upcoming.total) {
    const one = upcoming.total === 1;
    sentences.push(`Disabling does not remove ${upcoming.text} for ${one ? "a current or upcoming meeting" : "current and upcoming meetings"}. If Attendance is not enabled again within 7 days, LancerLogin stops tracking ${one ? "it, and it" : "them, and they"} must be deleted by hand.`);
  }
  return sentences;
}
