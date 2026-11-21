// Tab order inside a native time, date or date-and-time field.
//
// A browser's time field is one input with an hour, a minute and (on a 12-hour clock) an AM/PM segment, then a picker
// button; a datetime-local field has month, day and year segments before them, in the order the locale writes a date,
// and a date field has only the month, day and year before its picker button.
// Typing a digit that completes a segment already moves to the next one: 9 in the hour, 2 in the month, or the second
// digit of any two-digit segment. A Tab pressed straight after that digit, meant as "next segment", would then skip a
// segment: 9, Tab lands on AM/PM instead of the minutes, and 30, Tab lands on the picker button instead of AM/PM. The
// page cannot see which segment has focus, so this follows the keys typed into the field and reports the one Tab to
// ignore: a forward Tab pressed directly after a digit that moved on by itself. Every other key keeps the browser's own
// behaviour.
//
// Ported from the Outreach plugin's outreach-time-tab.ts (Core does not import plugin code). This file has no React
// import, so tests-ts can load it; useTimeFieldTab in use-time-field-tab.ts wires it to a field.

/** "after-minute" is where typing leaves the minutes: AM/PM on a 12-hour clock, still the minutes on a 24-hour one. */
export type TimeSegment = "month" | "day" | "year" | "hour" | "minute" | "after-minute" | "period" | "picker" | "unknown";
export type DateSegment = "month" | "day" | "year";
export type TimeTabState = { segment: TimeSegment; typed: string; advanced: boolean };
export type TimeTabKey = { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };
/**
 * The segments of a field: a time field has none for the date; a datetime-local field has all three, in the locale's
 * order. `twelveHour` says whether the field has an AM/PM segment. `time: false` is a date field, with no time segments.
 */
export type TimeFieldLayout = { twelveHour: boolean; date?: readonly DateSegment[]; time?: boolean };

/** Where a field starts: its first segment when focus arrives from before it, otherwise wherever the browser or pointer put it. */
export const timeTabStart = (segment: TimeSegment = "unknown"): TimeTabState => ({ segment, typed: "", advanced: false });
/** The first segment of a field, where keyboard focus from an earlier control lands. */
export const firstTimeSegment = (layout: TimeFieldLayout): TimeSegment => layout.date?.[0] ?? "hour";

/** The order the locale writes a numeric date in, which is the order of a datetime-local field's date segments. */
export function localeDateOrder(locale?: string): DateSegment[] {
  try {
    const order = new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(2026, 1, 15))
      .map((part) => part.type).filter((type): type is DateSegment => type === "month" || type === "day" || type === "year");
    if (order.length === 3 && new Set(order).size === 3) return order;
  } catch { /* the default below */ }
  return ["month", "day", "year"];
}

const timeSegments = (layout: TimeFieldLayout): TimeSegment[] => layout.time === false ? [] : ["hour", "minute", ...(layout.twelveHour ? ["period" as const] : [])];
const order = (layout: TimeFieldLayout): TimeSegment[] => [...(layout.date ?? []), ...timeSegments(layout), "picker"];
/** The last segment before the picker button, where the arrow keys stop. */
const lastSegment = (layout: TimeFieldLayout): TimeSegment => order(layout).at(-2) ?? "picker";
const moved = (segment: TimeSegment, by: number, layout: TimeFieldLayout, last: TimeSegment): TimeSegment => {
  const segments = order(layout); const index = segments.indexOf(segment);
  if (index < 0) return "unknown";
  return segments[Math.min(Math.max(index + by, 0), segments.indexOf(last))]!;
};

// A segment moves on once it holds two digits, or one digit no second digit could follow (2 to 9 for a 12-hour hour or a
// month, 3 to 9 for a 24-hour hour, 4 to 9 for a day, 6 to 9 for minutes). A year takes up to six digits and waits for Tab.
function typeDigit(state: TimeTabState, digit: string, layout: TimeFieldLayout): TimeTabState {
  const typed = state.typed + digit; const full = typed.length >= 2;
  const limit: Partial<Record<TimeSegment, number>> = { month: 12, day: 31, hour: layout.twelveHour ? 12 : 23 };
  const max = limit[state.segment];
  if (max !== undefined) return full || Number(typed) * 10 > max ? { segment: moved(state.segment, 1, layout, "picker"), typed: "", advanced: true } : { ...state, typed, advanced: false };
  // Whether the minutes move on to AM/PM is settled by the next key, when the caller knows more about the field.
  if (state.segment === "minute") return full || Number(typed) * 10 > 59 ? { segment: "after-minute", typed: "", advanced: false } : { ...state, typed, advanced: false };
  // After a click the segment is unknown. In a time field two digits, or 6 to 9, move on from the hour and the minutes
  // alike. A date or date-and-time field also has a year, which never moves on by itself, so there no digit is followed.
  if (state.segment === "unknown") return !layout.date && (full || Number(digit) >= 6) ? { segment: "unknown", typed: "", advanced: true } : { ...state, typed: layout.date ? "" : typed, advanced: false };
  return { ...state, typed: "", advanced: false };
}

/**
 * The state after one key pressed in the field, and whether that key is the Tab to ignore. `layout` is the field's
 * segments; `true` or `false` alone is a time field with or without AM/PM.
 */
export function timeTabKey(before: TimeTabState, event: TimeTabKey, layout: boolean | TimeFieldLayout): { state: TimeTabState; ignore: boolean } {
  const field: TimeFieldLayout = typeof layout === "boolean" ? { twelveHour: layout } : layout;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock"].includes(event.key)) return { state: before, ignore: false };
  const state: TimeTabState = before.segment === "after-minute" ? { segment: field.twelveHour ? "period" : "minute", typed: "", advanced: field.twelveHour } : before;
  const settled = (segment: TimeSegment): TimeTabState => ({ segment, typed: "", advanced: false });
  if (event.altKey || event.ctrlKey || event.metaKey) return { state: settled(state.segment), ignore: false };
  if (event.key === "Tab") {
    if (!event.shiftKey && state.advanced) return { state: settled(state.segment), ignore: true };
    return { state: settled(moved(state.segment, event.shiftKey ? -1 : 1, field, "picker")), ignore: false };
  }
  if (/^[0-9]$/.test(event.key)) return { state: typeDigit(state, event.key, field), ignore: false };
  // The arrow keys move between the segments but never onto the picker button.
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") return { state: settled(state.segment === "picker" ? "picker" : moved(state.segment, event.key === "ArrowLeft" ? -1 : 1, field, lastSegment(field))), ignore: false };
  return { state: settled(state.segment), ignore: false };
}
