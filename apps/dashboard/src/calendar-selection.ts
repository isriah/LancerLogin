import { useState } from "react";

export type CalendarSelection = { offset: number; selectedDate: string };
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00`)) && dateKey(new Date(`${value}T12:00:00`)) === value;
export function calendarMonth(today: string, offset: number) { const [year, month] = today.split("-").map(Number); return dateKey(new Date(year!, month! - 1 + offset, 1, 12)); }
export function selectionForDate(today: string, selectedDate: string): CalendarSelection {
  const base = new Date(`${today}T12:00:00`); const selected = new Date(`${selectedDate}T12:00:00`);
  return { offset: (selected.getFullYear() - base.getFullYear()) * 12 + selected.getMonth() - base.getMonth(), selectedDate };
}
export function readCalendarSelection(today: string, saved: string | null): CalendarSelection {
  const fallback = { offset: 0, selectedDate: today };
  if (!saved || saved.length > 256) return fallback;
  try { const value: unknown = JSON.parse(saved); if (!value || typeof value !== "object") return fallback; const { month, selectedDate } = value as Record<string, unknown>; if (!validDate(month) || !validDate(selectedDate) || month.slice(0, 7) !== selectedDate.slice(0, 7)) return fallback; return selectionForDate(today, selectedDate); } catch { return fallback; }
}
export function useCalendarSelection(key: string, today: string, persist = true) {
  const [selection, setSelection] = useState<CalendarSelection>(() => { try { return readCalendarSelection(today, window.sessionStorage.getItem(key)); } catch { return { offset: 0, selectedDate: today }; } });
  const change = (next: CalendarSelection) => { setSelection(next); if (persist) try { window.sessionStorage.setItem(key, JSON.stringify({ month: calendarMonth(today, next.offset), selectedDate: next.selectedDate })); } catch { /* Navigation still works when session storage is unavailable. */ } };
  return [selection, change] as const;
}
