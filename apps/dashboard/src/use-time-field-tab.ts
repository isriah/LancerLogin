// Wires the Tab handling in time-field-tab.ts to a native time, date or datetime-local input. Ported from the Outreach plugin's
// outreach-time-field-tab.ts.
import type React from "react";
import { useRef } from "react";
import { firstTimeSegment, localeDateOrder, timeTabKey, timeTabStart, type TimeFieldLayout, type TimeSegment, type TimeTabState } from "./time-field-tab";

// Time fields follow the operating system's clock setting on some systems, which the page cannot read. A time field that
// was empty and has had only its hour and minutes typed shows which clock it uses: it has a value on a 24-hour clock
// and none yet on a 12-hour clock, where AM/PM is still missing. What one field shows holds for every field, the time of
// a datetime-local field included. Until a time field shows it, the browser locale's clock is the guess.
let observedTwelveHour: boolean | undefined;
function guessedTwelveHour(): boolean {
  try { return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true; } catch { return true; }
}

/**
 * Props for a native `<input type="time">`, or with "date" or "datetime-local" an `<input>` of that type, that keep Tab
 * on the segment typing has just moved to.
 */
export function useTimeFieldTab(kind: "time" | "date" | "datetime-local" = "time") {
  const state = useRef<TimeTabState>(timeTabStart()); const pointer = useRef(false);
  // Whether a time field was empty when focus arrived, and has since seen only digits and Tab, in known segments. A
  // datetime-local field also needs its date before it has a value, so it never shows the clock this way.
  const conclusive = useRef(false); const typedInto = useRef({ hour: false, minute: false });
  const layout = (): TimeFieldLayout => ({ twelveHour: observedTwelveHour ?? guessedTwelveHour(), ...(kind === "time" ? {} : { date: localeDateOrder() }), ...(kind === "date" ? { time: false } : {}) });
  const begin = (segment: TimeSegment, empty: boolean) => { state.current = timeTabStart(segment); conclusive.current = kind === "time" && empty && segment === "hour"; typedInto.current = { hour: false, minute: false }; };
  return {
    onPointerDown: () => { pointer.current = true; begin("unknown", false); },
    onFocus: (event: React.FocusEvent<HTMLInputElement>) => {
      // Focus that arrives by keyboard from an earlier control starts on the first segment, and from a later one (Shift+Tab)
      // on the picker button. A click chooses its own segment.
      const from = event.relatedTarget; const position = !pointer.current && from instanceof Node ? from.compareDocumentPosition(event.currentTarget) : 0;
      const segment = position & Node.DOCUMENT_POSITION_FOLLOWING ? firstTimeSegment(layout()) : position & Node.DOCUMENT_POSITION_PRECEDING ? "picker" : "unknown";
      pointer.current = false; begin(segment, event.currentTarget.value === "");
    },
    onBlur: () => { pointer.current = false; begin("unknown", false); },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (conclusive.current && typedInto.current.hour && typedInto.current.minute) observedTwelveHour = event.currentTarget.value === "";
      const digit = /^[0-9]$/.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (digit && state.current.segment === "hour") typedInto.current.hour = true;
      else if (digit && state.current.segment === "minute") typedInto.current.minute = true;
      else if (!["Tab", "Shift"].includes(event.key)) conclusive.current = false;
      const result = timeTabKey(state.current, event, layout()); state.current = result.state;
      if (result.ignore) event.preventDefault();
    },
  };
}
