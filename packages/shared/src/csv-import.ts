// CSV import kit shared by dashboard previews and Worker rechecks: delimited text, loose header matching, and the date,
// time and duration formats imports accept. Pure functions only; the dashboard adds the template download.

export type CsvValue<T> = { ok: true; value: T } | { ok: false; error: string };
export type CsvHeaderMapping<Field extends string> = { columns: (Field | undefined)[]; recognised: Field[]; ignored: string[]; errors: string[] };
/** Aliases are normalised header names. A required entry that is a list needs at least one of its fields. */
export type CsvHeaderSpec<Field extends string> = { aliases: Record<string, Field>; labels: Record<Field, string>; required: readonly (Field | readonly Field[])[] };

const byteOrderMark = /^﻿/;

/** Lowercase without spaces, underscores, hyphens or dots, so "Start time", "start_time" and "startTime" match. */
export function normaliseCsvHeader(value: string): string {
  return value.replace(byteOrderMark, "").toLowerCase().replace(/[\s_.-]+/g, "");
}

export function csvFieldFor<Field extends string>(aliases: Record<string, Field>, header: string): Field | undefined {
  return Object.hasOwn(aliases, normaliseCsvHeader(header)) ? aliases[normaliseCsvHeader(header)] : undefined;
}

/** Tab when the first line has one (a spreadsheet paste), otherwise comma. */
export function delimiterFor(text: string): "," | "\t" {
  return text.replace(byteOrderMark, "").split(/\r\n|\n|\r/, 1)[0].includes("\t") ? "\t" : ",";
}

/** Rows of trimmed cells. Quotes may wrap delimiters and line breaks; "" is a literal quote; blank rows are dropped. */
export function parseDelimited(text: string): string[][] {
  const delimiter = delimiterFor(text);
  const rows: string[][] = []; let row: string[] = []; let value = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { row.push(value.trim()); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) { if (character === "\r" && text[index + 1] === "\n") index += 1; row.push(value.trim()); if (row.some(Boolean)) rows.push(row); row = []; value = ""; }
    else value += character;
  }
  row.push(value.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length) rows[0][0] = rows[0][0].replace(byteOrderMark, "");
  return rows;
}

/** Maps a header row to fields. Unknown headers are ignored; duplicate and missing required fields are errors. */
export function mapCsvHeader<Field extends string>(header: string[], spec: CsvHeaderSpec<Field>): CsvHeaderMapping<Field> {
  const columns = header.map((name) => csvFieldFor(spec.aliases, name)); const firstColumn = new Map<Field, string>(); const errors: string[] = []; const ignored: string[] = [];
  header.forEach((name, index) => {
    const field = columns[index];
    if (!field) { if (name.trim()) ignored.push(name.trim()); return; }
    const earlier = firstColumn.get(field);
    if (earlier !== undefined) { errors.push(`Columns "${earlier}" and "${name}" both match ${spec.labels[field]}. Keep only one.`); columns[index] = undefined; }
    else firstColumn.set(field, name);
  });
  for (const entry of spec.required) {
    const fields: readonly Field[] = typeof entry === "string" ? [entry] : entry;
    if (!fields.some((field) => firstColumn.has(field))) errors.push(`Missing column: ${fields.map((field) => spec.labels[field]).join(" or ")}`);
  }
  return { columns, recognised: columns.filter((field): field is Field => Boolean(field)), ignored, errors };
}

/** A CSV body: the header row's labels, then each row with commas, quotes and line breaks quoted. */
export function csvText(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map((cell) => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(",")).join("\n") + "\n";
}

const pad = (value: number) => String(value).padStart(2, "0");
const realDate = (year: number, month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
const dateHelp = "Use MM/DD/YYYY, such as 11/10/2026, or 2026-11-10";

/** MM/DD/YYYY (or M/D/YYYY) and ISO YYYY-MM-DD, as an ISO date. Day-first dates and two-digit years are refused. */
export function parseCsvDate(input: string): CsvValue<string> {
  const value = input.trim(); const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? { ok: true, value } : { ok: false, error: `${value} is not a real date` };
  if (!us) return { ok: false, error: value ? `${value} is not a date. ${dateHelp}` : `Add a date. ${dateHelp}` };
  const [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
  if (month > 12 && day <= 12) return { ok: false, error: `${value} looks like day/month. Use MM/DD/YYYY, such as ${pad(day)}/${pad(month)}/${year}` };
  if (!realDate(year, month, day)) return { ok: false, error: `${value} is not a real date` };
  return { ok: true, value: `${year}-${pad(month)}-${pad(day)}` };
}

/** An ISO date as MM/DD/YYYY, the format imports display. */
export function formatCsvDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${month}/${day}/${year}`;
}

const timeHelp = "Use 24-hour HH:MM, such as 18:00, or h:mm AM/PM, such as 6:00 PM";

/** 24-hour H:MM or HH:MM (optionally :00 seconds), or h:mm AM/PM and h AM/PM, as 24-hour HH:MM. */
export function parseCsvTime(input: string): CsvValue<string> {
  const value = input.trim(); const clock = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(value); const meridiem = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/.exec(value);
  if (clock && Number(clock[1]) <= 23 && Number(clock[2]) <= 59) return { ok: true, value: `${pad(Number(clock[1]))}:${clock[2]}` };
  if (meridiem && Number(meridiem[1]) >= 1 && Number(meridiem[1]) <= 12 && Number(meridiem[2] ?? 0) <= 59) {
    const hour = Number(meridiem[1]) % 12 + (meridiem[3].toLowerCase() === "p" ? 12 : 0);
    return { ok: true, value: `${pad(hour)}:${meridiem[2] ?? "00"}` };
  }
  return { ok: false, error: value ? `${value} is not a time. ${timeHelp}` : `Add a time. ${timeHelp}` };
}

/** A 24-hour HH:MM time as h:mm AM/PM. */
export function formatCsvTime(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

/** "6:00–8:30 PM" when both are in the same half of the day, otherwise "10:00 AM–1:00 PM". */
export function formatCsvTimeRange(start: string, end: string): string {
  const [from, to] = [formatCsvTime(start), formatCsvTime(end)];
  return from.slice(-2) === to.slice(-2) ? `${from.slice(0, -3)}–${to}` : `${from}–${to}`;
}

const durationHelp = "Use minutes (90), hours and minutes (1:30) or 1h30m";

/** Minutes (90), H:MM (1:30) or 1h30m / 2h / 45m, as whole minutes from 1 to 24 hours. */
export function parseCsvDuration(input: string): CsvValue<number> {
  const value = input.trim().toLowerCase(); const clock = /^(\d{1,2}):(\d{2})$/.exec(value); const units = /^(?:(\d{1,2})\s*h(?:ours?|rs?)?)?\s*(?:(\d{1,4})\s*m(?:in(?:utes?|s)?)?)?$/.exec(value);
  const minutes = /^\d{1,4}$/.test(value) ? Number(value)
    : clock && Number(clock[2]) <= 59 ? Number(clock[1]) * 60 + Number(clock[2])
      : units && (units[1] || units[2]) ? Number(units[1] ?? 0) * 60 + Number(units[2] ?? 0) : NaN;
  if (!Number.isFinite(minutes)) return { ok: false, error: value ? `${input.trim()} is not a duration. ${durationHelp}` : `Add a duration. ${durationHelp}` };
  if (minutes < 1 || minutes > 1440) return { ok: false, error: "Duration must be from 1 minute to 24 hours" };
  return { ok: true, value: minutes };
}
