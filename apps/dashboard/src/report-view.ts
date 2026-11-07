/** A count with its noun, singular only for exactly one: `1 matching row`, `0 matching rows`, `2 members`. */
export const countText = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function latestTrendPoints<T extends { meetingId: string; startsAt: string }>(points: T[], limit: number): T[] {
  return [...points]
    .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt) || left.meetingId.localeCompare(right.meetingId))
    .slice(0, limit)
    .reverse();
}

/**
 * Today's date in the installation's time zone, as the API resolves report periods. The UTC date is a day ahead every
 * evening in the Americas, which made a new custom range start tomorrow and match nothing.
 */
export function installationToday(timeZone: string, now = Date.now()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
  catch { return new Date(now).toISOString().slice(0, 10); }
}

/** The whole calendar month before `today`'s month, as the API resolves the Last month report period. */
export function lastMonthRange(today: string): { from: string; to: string } {
  const to = new Date(today.slice(0, 7) + "-01T12:00:00.000Z"); to.setUTCDate(0);
  const end = to.toISOString().slice(0, 10);
  return { from: end.slice(0, 7) + "-01", to: end };
}

export function reportExportFilename(name: string, detail: boolean, date = new Date()): string {
  const label = name.normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 64) || "report";
  return `lancerlogin-${label}-${date.toISOString().slice(0, 10)}${detail ? "-detail" : ""}.csv`;
}

type FilterOperator = "contains" | "minimum" | "equals" | "maximum" | "between" | "empty" | "not_empty";
type DurationUnit = "minutes" | "hours" | "hours_minutes";
type Period = { type: "all" | "current_month" | "last_month" | "current_year" } | { type: "baseline"; module?: string } | { type: "last_days"; days: 7 | 30 | 60 | 90 } | { type: "fixed"; from: string; to: string };

/** Minutes as H:MM, such as 125 as 2:05. Values that aren't whole minutes stay as typed. */
export function minutesAsHoursMinutes(value: string): string {
  if (!/^-?\d+$/.test(value.trim())) return value;
  const total = Number(value); const sign = total < 0 ? "-" : ""; const magnitude = Math.abs(total);
  return `${sign}${Math.floor(magnitude / 60)}:${String(magnitude % 60).padStart(2, "0")}`;
}

/** Typed H:MM as whole minutes: 2:00 is 120, 1:30 is 90, and a whole number is hours. Undefined when it isn't H:MM. */
export function hoursMinutesAsMinutes(value: string): string | undefined {
  const text = value.trim();
  const match = /^(\d{1,5})(?::([0-5]\d))?$/.exec(text);
  if (!match) return;
  return String(Number(match[1]) * 60 + Number(match[2] ?? 0));
}

/** A filter value as its column shows it: H:MM columns store minutes but read as H:MM. */
export const reportFilterValueText = (value: string, unit?: DurationUnit) => unit === "hours_minutes" ? minutesAsHoursMinutes(value) : value;

/** The words on an active filter chip, such as "Hours (H:MM) ≥ 2:00" or "Activity contains “robot”". */
export function reportColumnFilterText(name: string, filter: { column: { unit?: DurationUnit }; operator: FilterOperator; value: string; upperValue?: string }): string {
  const value = reportFilterValueText(filter.value, filter.column.unit); const upper = reportFilterValueText(filter.upperValue ?? "", filter.column.unit);
  switch (filter.operator) {
    case "contains": return `${name} contains “${value}”`;
    case "equals": return `${name} = ${value}`;
    case "minimum": return `${name} ≥ ${value}`;
    case "maximum": return `${name} ≤ ${value}`;
    case "between": return `${name} ${value} to ${upper}`;
    case "empty": return `${name} is empty`;
    default: return `${name} is not empty`;
  }
}

/** The period chip's choices, as select values and labels. The baseline's label names its module, so it is filled in where shown. */
export const reportPeriodOptions = [["all", "All history"], ["baseline", "Operational baseline"], ["last_7", "Last 7 days"], ["last_30", "Last 30 days"], ["last_60", "Last 60 days"], ["last_90", "Last 90 days"], ["current_month", "Current month"], ["last_month", "Last month"], ["current_year", "Current year"], ["fixed", "Custom fixed range"]] as const;

/** The period select's value for a stored period, such as last_30 for the last 30 days. */
export const reportPeriodChoice = (period: Period) => period.type === "last_days" ? `last_${period.days}` : period.type;

/** The period a select value stores. A custom range starts and ends on `today`; keeping the current range when it is one. */
export function reportPeriodFromChoice(choice: string, today: string, current?: Period): Period {
  const days = /^last_(\d+)$/.exec(choice);
  if (days && [7, 30, 60, 90].includes(Number(days[1]))) return { type: "last_days", days: Number(days[1]) as 7 | 30 | 60 | 90 };
  if (choice === "fixed") return current?.type === "fixed" ? { ...current } : { type: "fixed", from: today, to: today };
  if (choice === "baseline") return current?.type === "baseline" ? { ...current } : { type: "baseline" };
  if (choice === "current_month" || choice === "last_month" || choice === "current_year") return { type: choice };
  return { type: "all" };
}
