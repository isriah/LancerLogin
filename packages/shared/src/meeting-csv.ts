// Attendance meeting CSV columns and row rules, shared by the dashboard preview and the Worker, which rechecks every row.
import { addCalendarDays } from "./civil-time.ts";
import { csvFieldFor, csvText, delimiterFor, formatCsvDate, formatCsvTime, mapCsvHeader, parseCsvDate, parseCsvDuration, parseCsvTime, parseDelimited } from "./csv-import.ts";

export type MeetingCsvField = "title" | "date" | "startTime" | "endTime" | "duration" | "attendance" | "audience" | "weight" | "notes";
export type MeetingCsvValues = Partial<Record<MeetingCsvField, string>>;
/** One data row: its line number in the file and the cells of recognised columns only. A missing key means the column is absent. */
export type MeetingCsvRow = { rowNumber: number; values: MeetingCsvValues };
export type ParsedMeetingCsv = { hasHeader: boolean; recognised: MeetingCsvField[]; ignored: string[]; errors: string[]; rows: MeetingCsvRow[] };
/**
 * A row's meeting in the organization time zone. `required`, `audienceNames`, `weightName` and `notes` are undefined when
 * their column is absent (an update keeps the current value); blank cells are Required, all members, automatic and no notes.
 */
export type MeetingCsvMeeting = { title: string; date: string; startTime: string; endDate: string; endTime: string; startsAt: string; endsAt: string; required?: boolean; audienceNames?: string[]; weightName?: string | null; notes?: string | null };

export const meetingCsvFields: MeetingCsvField[] = ["title", "date", "startTime", "endTime", "duration", "attendance", "audience", "weight", "notes"];
export const meetingCsvFieldLabels: Record<MeetingCsvField, string> = { title: "Title", date: "Date", startTime: "Start time", endTime: "End time", duration: "Duration", attendance: "Attendance", audience: "Audience labels", weight: "Weight category", notes: "Notes" };
export const meetingCsvFieldHelp: { field: MeetingCsvField; label: string; required: string; example: string }[] = [
  { field: "title", label: meetingCsvFieldLabels.title, required: "Required", example: "Test Build Session" },
  { field: "date", label: meetingCsvFieldLabels.date, required: "Required", example: "11/10/2026" },
  { field: "startTime", label: meetingCsvFieldLabels.startTime, required: "Required", example: "18:00" },
  { field: "endTime", label: meetingCsvFieldLabels.endTime, required: "Required unless Duration", example: "20:30" },
  { field: "duration", label: meetingCsvFieldLabels.duration, required: "Optional", example: "1:30" },
  { field: "attendance", label: meetingCsvFieldLabels.attendance, required: "Optional", example: "Required" },
  { field: "audience", label: meetingCsvFieldLabels.audience, required: "Optional", example: "Test Label A;Test Label B" },
  { field: "weight", label: meetingCsvFieldLabels.weight, required: "Optional", example: "" },
  { field: "notes", label: meetingCsvFieldLabels.notes, required: "Optional", example: "" },
];
export const meetingCsvRowLimit = 200;
/** Longest cell the Worker reads; longer cells are refused before any parsing. */
export const meetingCsvCellLimit = 2_000;
export const meetingCsvTemplate = csvText([
  meetingCsvFields.map((field) => meetingCsvFieldLabels[field]),
  ["Test Build Session", "11/10/2026", "18:00", "20:30", "", "Required", "", "", "Synthetic example"],
  ["Test Drive Practice", "11/12/2026", "3:30 PM", "", "2h", "Optional", "Test Label A", "", ""],
]);

const aliases: Record<string, MeetingCsvField> = {
  title: "title", meeting: "title", meetingtitle: "title", name: "title", event: "title",
  date: "date", meetingdate: "date", day: "date",
  starttime: "startTime", start: "startTime", from: "startTime", begins: "startTime",
  endtime: "endTime", end: "endTime", to: "endTime", ends: "endTime",
  duration: "duration", length: "duration", minutes: "duration",
  attendance: "attendance", required: "attendance", type: "attendance",
  audiencelabels: "audience", audience: "audience", labels: "audience",
  weightcategory: "weight", weight: "weight", category: "weight",
  notes: "notes", description: "notes", details: "notes",
};
const headerSpec = { aliases, labels: meetingCsvFieldLabels, required: [["title"], ["date"], ["startTime"], ["endTime", "duration"]] as const };

export const meetingCsvFieldFor = (header: string) => csvFieldFor(aliases, header);

/** Parses pasted or uploaded meeting text. Comma-separated text needs a header; tab-separated rows may omit it when they follow the template order. */
export function parseMeetingCsvText(text: string): ParsedMeetingCsv {
  const parsed = parseDelimited(text); const first = parsed[0] ?? [];
  const hasHeader = delimiterFor(text) === "," || first.some((value) => Boolean(meetingCsvFieldFor(value)));
  const errors: string[] = []; let columns: (MeetingCsvField | undefined)[] = meetingCsvFields; let recognised: MeetingCsvField[] = []; let ignored: string[] = [];
  if (hasHeader) { const mapping = mapCsvHeader(parsed.shift() ?? [], headerSpec); columns = mapping.columns; recognised = mapping.recognised; ignored = mapping.ignored; errors.push(...mapping.errors); }
  const rowOffset = hasHeader ? 2 : 1;
  const width = hasHeader ? columns.length : Math.min(meetingCsvFields.length, Math.max(4, ...parsed.map((row) => row.length)));
  if (!hasHeader) { columns = meetingCsvFields.slice(0, width); recognised = [...columns] as MeetingCsvField[]; }
  const rows = parsed.map((row, index) => {
    if (!hasHeader && (row.length < 4 || row.length > meetingCsvFields.length)) errors.push(`Row ${index + rowOffset} needs four to nine tab-separated columns in this order: ${meetingCsvFields.map((field) => meetingCsvFieldLabels[field]).join(", ")}.`);
    const values: MeetingCsvValues = {};
    columns.forEach((field, column) => { if (field) values[field] = row[column] ?? ""; });
    return { rowNumber: index + rowOffset, values };
  });
  return { hasHeader, recognised, ignored, errors, rows };
}

const yes = new Set(["required", "yes", "y", "true", "1"]); const no = new Set(["optional", "no", "n", "false", "0"]);
const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const pad = (value: number) => String(value).padStart(2, "0");
const dayMs = 86_400_000; const spanMs = 7 * dayMs;
/**
 * Wall-clock conversion for one time zone, as civil-time's resolveCivilTime does, but with offsets memoised per UTC week and
 * transitions found once by binary search, so a 200-row import formats about a hundred instants instead of thousands.
 * Assumes at most one offset change per week and changes on whole seconds, true of every zone in use today.
 */
export type MeetingCsvClock = { timeZone: string; offsetAt: (epoch: number) => number; instant: (date: string, time: string) => string; civil: (epoch: number) => { date: string; time: string } };
const clocks = new Map<string, MeetingCsvClock>();
/** One clock per zone for the isolate's life (zone rules do not change while it runs), so each preview reuses the sampled offsets. */
export function meetingCsvClock(timeZone: string): MeetingCsvClock {
  const cached = clocks.get(timeZone); if (cached) return cached;
  const clock = createClock(timeZone); if (clocks.size >= 4) clocks.delete(clocks.keys().next().value!); clocks.set(timeZone, clock);
  return clock;
}
function createClock(timeZone: string): MeetingCsvClock {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { throw new Error(`${timeZone} is not a supported time zone`); }
  const sampled = new Map<number, number>(); const transitions = new Map<number, number>();
  const measure = (epoch: number) => { const parts = Object.fromEntries(format.formatToParts(epoch).map((part) => [part.type, part.value])); return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(epoch / 1000) * 1000; };
  const spanOffset = (span: number) => { let value = sampled.get(span); if (value === undefined) { value = measure(span * spanMs); sampled.set(span, value); } return value; };
  const offsetAt = (epoch: number) => {
    const span = Math.floor(epoch / spanMs); const before = spanOffset(span); const after = spanOffset(span + 1);
    if (before === after) return before;
    let change = transitions.get(span);
    if (change === undefined) { let low = span * spanMs; let high = (span + 1) * spanMs; while (high - low > 1000) { const middle = low + Math.floor((high - low) / 2000) * 1000; if (measure(middle) === before) low = middle; else high = middle; } change = high; transitions.set(span, change); }
    return epoch < change ? before : after;
  };
  const instant = (date: string, time: string) => {
    const nominal = Date.parse(`${date}T${time}:00.000Z`);
    const candidates = [...new Set([offsetAt(nominal - dayMs), offsetAt(nominal + dayMs)])].map((offset) => nominal - offset).filter((epoch) => epoch + offsetAt(epoch) === nominal).sort((left, right) => left - right);
    const when = `${formatCsvTime(time)} on ${formatCsvDate(date)} in ${timeZone}`;
    if (!candidates.length) throw new Error(`${when} doesn't exist: clocks move forward for daylight saving time. Choose another time`);
    if (candidates.length > 1) throw new Error(`${when} happens twice: clocks move back for daylight saving time. Choose another time`);
    return new Date(candidates[0]!).toISOString();
  };
  const civil = (epoch: number) => { const local = new Date(epoch + offsetAt(epoch)); return { date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`, time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}` }; };
  return { timeZone, offsetAt, instant, civil };
}

/** Checks one row's values and places it in the time zone (pass one meetingCsvClock for a whole file). An end at or before the start ends the next day. Returns every problem found. */
export function resolveMeetingCsvRow(values: MeetingCsvValues, zone: string | MeetingCsvClock): { meeting: MeetingCsvMeeting; errors?: undefined } | { meeting?: undefined; errors: string[] } {
  const clock = typeof zone === "string" ? meetingCsvClock(zone) : zone; const errors: string[] = [];
  if (Object.values(values).some((value) => typeof value !== "string" || value.length > meetingCsvCellLimit)) return { errors: [`Each cell must be text of at most ${meetingCsvCellLimit} characters`] };
  const title = (values.title ?? "").trim(); const notes = values.notes === undefined ? undefined : values.notes.trim() || null;
  if (!title) errors.push("Add a title"); else if (title.length > 120) errors.push("Title must be 120 characters or fewer");
  if (notes && notes.length > 2_000) errors.push("Notes must be 2,000 characters or fewer");
  const date = parseCsvDate(values.date ?? ""); const start = parseCsvTime(values.startTime ?? "");
  const endText = (values.endTime ?? "").trim(); const durationText = (values.duration ?? "").trim();
  const end = endText ? parseCsvTime(endText) : undefined; const duration = durationText ? parseCsvDuration(durationText) : undefined;
  for (const value of [date, start, end, duration]) if (value && !value.ok) errors.push(value.error);
  if (!end && !duration) errors.push("Add an end time or a duration");
  const attendance = values.attendance?.trim().toLowerCase();
  const required = attendance === undefined ? undefined : !attendance || yes.has(attendance) ? true : no.has(attendance) ? false : undefined;
  if (attendance && required === undefined) errors.push(`Attendance must be Required or Optional, not ${values.attendance!.trim()}`);
  const names = values.audience === undefined ? undefined : values.audience.split(";").map((name) => name.trim()).filter(Boolean);
  const audienceNames = names?.filter((name, index) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index);
  if ((audienceNames?.length ?? 0) > 30) errors.push("Choose at most 30 audience labels");
  const weightName = values.weight === undefined ? undefined : values.weight.trim() || null;
  if (errors.length || !date.ok || !start.ok) return { errors };
  let startsAt: string; let endsAt: string; let endDate = date.value; let endTime: string;
  try {
    startsAt = clock.instant(date.value, start.value);
    if (end?.ok) {
      endDate = clockMinutes(end.value) <= clockMinutes(start.value) ? addCalendarDays(date.value, 1) : date.value; endTime = end.value;
      endsAt = clock.instant(endDate, end.value);
      if (duration?.ok && Date.parse(endsAt) - Date.parse(startsAt) !== duration.value * 60_000) return { errors: ["End time and Duration disagree. Keep one of them"] };
    } else {
      endsAt = new Date(Date.parse(startsAt) + (duration as { value: number }).value * 60_000).toISOString();
      const local = clock.civil(Date.parse(endsAt)); endDate = local.date; endTime = local.time;
    }
  } catch (error) { return { errors: [(error as Error).message] }; }
  return { meeting: { title, date: date.value, startTime: start.value, endDate, endTime, startsAt, endsAt, required, audienceNames, weightName, notes } };
}
