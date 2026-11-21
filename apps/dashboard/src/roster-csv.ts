import { csvFieldFor, delimiterFor, mapCsvHeader, parseDelimited } from "./csv-import.ts";

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

const rosterHeaderSpec = { aliases: rosterAliases, labels: rosterFieldLabels, required: requiredRosterFields };

export function rosterFieldFor(header: string): RosterField | undefined {
  return csvFieldFor(rosterAliases, header);
}

export { delimiterFor, parseDelimited };

/** Maps a header row to roster fields. Unknown headers are ignored; duplicate and missing required fields are errors. */
export function mapRosterHeader(header: string[]): { columns: (RosterField | undefined)[]; recognised: RosterField[]; ignored: string[]; errors: string[] } {
  return mapCsvHeader(header, rosterHeaderSpec);
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

export const validDiscordUserId = (value: string | null | undefined) => /^\d{10,24}$/.test(value ?? "");

/** The member a roster row sends to the server: an invalid Discord user ID is left out, so it is ignored. */
export function importedRosterMember(member: RosterRecord): RosterRecord {
  return { ...member, discordUserId: validDiscordUserId(member.discordUserId) ? member.discordUserId : undefined };
}

export type StoredRosterMember = { firstName: string; lastName: string; email?: string | null; discordUserId?: string | null; active: boolean | number };
export type RosterImportStatus = "Add" | "Update" | "Unchanged";

/**
 * What importing one row stores, by the server's rule (POST /admin/members): names always come from the row; Email and
 * Discord user ID change only to a value the row gives, so a missing column, a blank cell or an ignored Discord ID keeps
 * the stored value. Emails are stored trimmed and lower-case. An inactive member is reactivated.
 */
export function rosterImportPreviewRow(current: StoredRosterMember | undefined, member: RosterRecord): RosterRecord & { status: RosterImportStatus } {
  const email = member.email?.trim().toLowerCase() || current?.email || undefined;
  const discordUserId = (validDiscordUserId(member.discordUserId) ? member.discordUserId : undefined) || current?.discordUserId || undefined;
  const next = { memberId: member.memberId, firstName: member.firstName, lastName: member.lastName, email, discordUserId };
  if (!current) return { ...next, status: "Add" };
  const unchanged = current.firstName === next.firstName && current.lastName === next.lastName && (current.email ?? "") === (email ?? "") && (current.discordUserId ?? "") === (discordUserId ?? "") && Boolean(current.active);
  return { ...next, status: unchanged ? "Unchanged" : "Update" };
}
