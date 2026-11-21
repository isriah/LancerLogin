// The dashboard's one native date field. It is an ordinary native date input with the Tab handling from
// use-time-field-tab.ts: typing a digit that completes the month or day already moves on, so the Tab pressed after it
// stays on the next segment instead of skipping one. tests-ts/time-field-tab.test.ts fails if a dashboard file renders a
// date input any other way.
import type React from "react";
import { useTimeFieldTab } from "./use-time-field-tab";

type Handler<E> = ((event: E) => void) | undefined;
const both = <E,>(first: Handler<E>, second: Handler<E>) => (event: E) => { first?.(event); second?.(event); };

export type DateInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/** A native date input; every prop passes through, and its own focus, blur, pointer and key handlers still run. */
export function DateInput(props: DateInputProps) {
  const tab = useTimeFieldTab("date");
  return <input {...props} type="date" onPointerDown={both(tab.onPointerDown, props.onPointerDown)} onFocus={both(tab.onFocus, props.onFocus)} onBlur={both(tab.onBlur, props.onBlur)} onKeyDown={both(tab.onKeyDown, props.onKeyDown)} />;
}
