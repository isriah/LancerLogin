export type RosterField = "memberId" | "firstName" | "lastName" | "email" | "discordUserId";
export type RosterRecord = { memberId: string; firstName: string; lastName: string; email?: string; discordUserId?: string };
export type RosterFieldHelp = { field: RosterField; label: string; required: boolean; example: string };
export type ParsedRoster = { hasHeader: boolean; recognised: RosterField[]; ignored: string[]; errors: string[]; rows: { rowNumber: number; member: RosterRecord }[] };

export const rosterFields: RosterField[] = ["memberId", "firstName", "lastName", "email", "discordUserId"];
export const requiredRosterFields: RosterField[] = ["memberId", "firstName", "lastName"];
export const rosterFieldLabels: Record<RosterField, string> = { memberId: "Member ID", firstName: "First name", lastName: "Last name", email: "Email", discordUserId: "Discord user ID" };
export const rosterFieldHelp: RosterFieldHelp[] = [
  { field: "memberId", label: rosterFieldLabels.memberId, required: true, example: "9001" },
  { field: "firstName", label: rosterFieldLabels.firstName, required: true, example: "Test" },
  { field: "lastName", label: rosterFieldLabels.lastName, required: true, example: "Student" },
  { field: "email", label: rosterFieldLabels.email, required: false, example: "test.student@example.test" },
  { field: "discordUserId", label: rosterFieldLabels.discordUserId, required: false, example: "17 to 20 digit Discord ID" },
];
export const rosterTemplateCsv = `${rosterFields.map((field) => rosterFieldLabels[field]).join(",")}\n9001,Test,Student,test.student@example.test,\n`;

const rosterAliases: Record<string, RosterField> = {
  memberid: "memberId", id: "memberId", studentid: "memberId", member: "memberId",
  firstname: "firstName", first: "firstName", givenname: "firstName",
  lastname: "lastName", last: "lastName", surname: "lastName", familyname: "lastName",
  email: "email", emailaddress: "email", mail: "email",
  discorduserid: "discordUserId", discordid: "discordUserId", discord: "discordUserId",
};

export function normaliseRosterHeader(value: string): string {
  return value.replace(/^﻿/, "").toLowerCase().replace(/[\s_.-]+/g, "");
}

export function rosterFieldFor(header: string): RosterField | undefined {
  return rosterAliases[normaliseRosterHeader(header)];
}

export function delimiterFor(text: string): "," | "\t" {
  return text.replace(/^﻿/, "").split(/\r\n|\n|\r/, 1)[0].includes("\t") ? "\t" : ",";
}

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
  if (rows.length) rows[0][0] = rows[0][0].replace(/^﻿/, "");
  return rows;
}

/** Maps a header row to roster fields. Unknown headers are ignored; duplicate and missing required fields are errors. */
export function mapRosterHeader(header: string[]): { columns: (RosterField | undefined)[]; recognised: RosterField[]; ignored: string[]; errors: string[] } {
  const columns = header.map(rosterFieldFor); const firstColumn = new Map<RosterField, string>(); const errors: string[] = []; const ignored: string[] = [];
  header.forEach((name, index) => {
    const field = columns[index];
    if (!field) { if (name.trim()) ignored.push(name.trim()); return; }
    const earlier = firstColumn.get(field);
    if (earlier !== undefined) { errors.push(`Columns "${earlier}" and "${name}" both match ${rosterFieldLabels[field]}. Keep only one.`); columns[index] = undefined; }
    else firstColumn.set(field, name);
  });
  for (const field of requiredRosterFields) if (!firstColumn.has(field)) errors.push(`Missing column: ${rosterFieldLabels[field]}`);
  return { columns, recognised: columns.filter((field): field is RosterField => Boolean(field)), ignored, errors };
}

/** Parses pasted or uploaded roster text. Comma-separated text needs a header; tab-separated rows may omit it when they follow the template column order. */
export function parseRosterText(text: string): ParsedRoster {
  const parsed = parseDelimited(text); const first = parsed[0] ?? [];
  const hasHeader = delimiterFor(text) === "," || first.some((value) => Boolean(rosterFieldFor(value)));
  const errors: string[] = []; let columns: (RosterField | undefined)[] = rosterFields; let recognised: RosterField[] = []; let ignored: string[] = [];
  if (hasHeader) { const mapping = mapRosterHeader(parsed.shift() ?? []); columns = mapping.columns; recognised = mapping.recognised; ignored = mapping.ignored; errors.push(...mapping.errors); }
  const rowOffset = hasHeader ? 2 : 1;
  const rows = parsed.map((row, index) => {
    if (!hasHeader && (row.length < requiredRosterFields.length || row.length > rosterFields.length)) errors.push(`Row ${index + rowOffset} needs three to five tab-separated columns in this order: ${rosterFields.map((field) => rosterFieldLabels[field]).join(", ")}.`);
    const member: Record<string, string> = { memberId: "", firstName: "", lastName: "" };
    columns.forEach((field, column) => { if (field) member[field] = row[column] ?? ""; });
    return { rowNumber: index + rowOffset, member: member as RosterRecord };
  });
  if (!hasHeader) recognised = rosterFields.slice(0, Math.min(rosterFields.length, Math.max(requiredRosterFields.length, ...parsed.map((row) => row.length))));
  return { hasHeader, recognised, ignored, errors, rows };
}
