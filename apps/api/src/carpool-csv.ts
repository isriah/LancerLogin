import type { CarpoolStatus } from "./carpool-planning.ts";
import type { CarpoolTripScope } from "../../../packages/shared/src/carpool-state.ts";

export type CarpoolColumnMapping = {
  name: string;
  contact?: string;
  memberId?: string;
  outboundStatus: string;
  outboundAddress: string;
  outboundLatitude?: string;
  outboundLongitude?: string;
  outboundSeats?: string;
  returnStatus: string;
  returnAddress?: string;
  returnLatitude?: string;
  returnLongitude?: string;
  returnSeats?: string;
  notes?: string;
};

export type CarpoolImportPerson = {
  importIdentity: string;
  displayName: string;
  contact: string;
  memberExternalId: string | null;
  sourceRow: number;
  outboundSourceStatus: string;
  outboundStatus: CarpoolStatus;
  outboundAddress: string;
  outboundLatitude: number | null;
  outboundLongitude: number | null;
  outboundSeats: number | null;
  returnSourceStatus: string;
  returnStatus: CarpoolStatus;
  returnAddress: string;
  returnLatitude: number | null;
  returnLongitude: number | null;
  returnSeats: number | null;
  returnSameAsOutbound: boolean;
  notes: string;
};

export function parseCarpoolCsv(text: string) {
  if (text.length > 2_000_000) throw new Error("CSV must be 2 MB or smaller.");
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = ""; if (row.some((value) => value.length)) rows.push(row); row = [];
    } else field += character;
  }
  if (quoted) throw new Error("CSV contains an unfinished quoted field.");
  row.push(field); if (row.some((value) => value.length)) rows.push(row);
  if (rows.length > 501) throw new Error("Import up to 500 participants at a time.");
  const wideRow = rows.findIndex((values) => values.length > 100);
  if (wideRow >= 0) throw new Error(`CSV row ${wideRow + 1} has ${rows[wideRow]!.length} columns. Carpool supports up to 100 columns.`);
  const longFieldRow = rows.findIndex((values) => values.some((value) => value.length > 4_000));
  if (longFieldRow >= 0) {
    const longFieldColumn = rows[longFieldRow]!.findIndex((value) => value.length > 4_000);
    throw new Error(`CSV row ${longFieldRow + 1}, column ${longFieldColumn + 1} is longer than 4,000 characters. Shorten that cell and try again.`);
  }
  const headers = rows.shift()?.map((value) => value.trim()) ?? [];
  if (headers.length > 100) throw new Error(`CSV has ${headers.length} columns. Carpool supports up to 100 columns.`);
  const longHeader = headers.findIndex((header) => header.length > 500);
  if (longHeader >= 0) throw new Error(`CSV column ${longHeader + 1} has a header longer than 500 characters. Shorten that header and try again.`);
  if (!headers.length || new Set(headers).size !== headers.length || headers.some((header) => !header)) throw new Error("CSV needs one non-empty, unique header row.");
  const records = rows.map((values, index) => Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""])) as Record<string, string>);
  return { headers, records };
}

function status(value: string): CarpoolStatus {
  const normalized = value.trim().toLocaleLowerCase().replace(/[ _]+/g, "-");
  if (["offer", "offering", "driver", "driving", "can-drive", "arranged-with-seats", "getting-a-ride-and-can-bring-others"].includes(normalized)) return "offer";
  if (["arranged", "has-ride", "ride-arranged", "arranged-without-seats", "getting-a-ride-but-cannot-bring-others"].includes(normalized)) return "arranged";
  if (["needs-ride", "need-a-ride", "request", "rider"].includes(normalized)) return "needs-ride";
  if (["transit", "self", "self-arranged", "self-arranged-transit", "septa", "walk", "walking", "bike", "biking"].includes(normalized)) return "transit";
  return "unknown";
}

function optionalNumber(value: string, minimum: number, maximum: number) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

function seats(value: string, currentStatus: CarpoolStatus) {
  if (currentStatus !== "offer") return null;
  const parsed = optionalNumber(value, 0, 99);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

export function mapCarpoolCsv(text: string, mapping: CarpoolColumnMapping, scope: CarpoolTripScope = "both") {
  const parsed = parseCarpoolCsv(text);
  const mappingKeys = new Set(["name", "contact", "memberId", "outboundStatus", "outboundAddress", "outboundLatitude", "outboundLongitude", "outboundSeats", "returnStatus", "returnAddress", "returnLatitude", "returnLongitude", "returnSeats", "notes"]);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || Object.keys(mapping).some((key) => !mappingKeys.has(key)) || Object.values(mapping).some((header) => typeof header !== "string")) throw new Error("Provide a valid Carpool column mapping.");
  mapping = { ...mapping };
  if (scope === "outbound") for (const key of ["returnStatus", "returnAddress", "returnLatitude", "returnLongitude", "returnSeats"] as const) mapping[key] = "";
  if (scope === "return") { mapping.outboundStatus = ""; mapping.outboundSeats = ""; if (mapping.returnAddress) { mapping.outboundAddress = ""; mapping.outboundLatitude = ""; mapping.outboundLongitude = ""; } }
  const required = [mapping.name, ...(scope !== "return" ? [mapping.outboundStatus, mapping.outboundAddress] : []), ...(scope !== "outbound" ? [mapping.returnStatus, mapping.returnAddress || mapping.outboundAddress] : [])];
  if (required.some((header) => !parsed.headers.includes(header))) throw new Error("Choose existing CSV columns for name, status, and address in every planned trip direction.");
  if (Object.values(mapping).some((header) => header && !parsed.headers.includes(header))) throw new Error("Every mapped column must exist in the CSV header.");
  const headerKey = parsed.headers.join("\u001f");
  if (headerKey.length > 2_000) throw new Error(`CSV column names use ${headerKey.length} characters in total. Shorten them to 2,000 characters or fewer before importing.`);
  const people: CarpoolImportPerson[] = []; const issues: Array<{ row: number; message: string }> = []; const identities = new Map<string, number>();
  parsed.records.forEach((record, index) => {
    const row = index + 2; const displayName = record[mapping.name]?.trim() ?? "";
    if (!displayName) { issues.push({ row, message: "Name is required." }); return; }
    if (displayName.length > 150) issues.push({ row, message: "Name must be 150 characters or fewer." });
    const outboundSourceStatus = scope === "return" ? "" : record[mapping.outboundStatus]?.trim() ?? ""; const returnSourceStatus = scope === "outbound" ? "" : record[mapping.returnStatus]?.trim() ?? "";
    const outboundStatus = status(outboundSourceStatus); const returnStatus = status(returnSourceStatus);
    const outboundAddress = record[mapping.outboundAddress]?.trim() ?? "";
    const returnMapped = mapping.returnAddress ? record[mapping.returnAddress]?.trim() ?? "" : "";
    const returnAddress = returnMapped || outboundAddress;
    if (outboundAddress.length > 500) issues.push({ row, message: "Outbound address must be 500 characters or fewer." });
    if (returnAddress.length > 500) issues.push({ row, message: "Return address must be 500 characters or fewer." });
    const outboundLatitude = mapping.outboundLatitude ? optionalNumber(record[mapping.outboundLatitude] ?? "", -90, 90) : null;
    const outboundLongitude = mapping.outboundLongitude ? optionalNumber(record[mapping.outboundLongitude] ?? "", -180, 180) : null;
    const returnLatitude = mapping.returnLatitude ? optionalNumber(record[mapping.returnLatitude] ?? "", -90, 90) : returnAddress === outboundAddress ? outboundLatitude : null;
    const returnLongitude = mapping.returnLongitude ? optionalNumber(record[mapping.returnLongitude] ?? "", -180, 180) : returnAddress === outboundAddress ? outboundLongitude : null;
    if ((outboundLatitude === null) !== (outboundLongitude === null)) issues.push({ row, message: "Outbound latitude and longitude must both be provided." });
    if ((returnLatitude === null) !== (returnLongitude === null)) issues.push({ row, message: "Return latitude and longitude must both be provided." });
    if (scope !== "return" && ["offer", "needs-ride"].includes(outboundStatus) && !outboundAddress) issues.push({ row, message: "Outbound ride participants need an address." });
    if (scope !== "outbound" && ["offer", "needs-ride"].includes(returnStatus) && !returnAddress) issues.push({ row, message: "Return ride participants need an address." });
    const outboundSeats = seats(mapping.outboundSeats ? record[mapping.outboundSeats] ?? "" : "", outboundStatus);
    const returnSeats = seats(mapping.returnSeats ? record[mapping.returnSeats] ?? "" : "", returnStatus);
    if (scope !== "return" && outboundStatus === "offer" && outboundSeats === null) issues.push({ row, message: "Outbound drivers need a whole-number seat count." });
    if (scope !== "outbound" && returnStatus === "offer" && returnSeats === null) issues.push({ row, message: "Return drivers need a whole-number seat count." });
    const contact = mapping.contact ? record[mapping.contact]?.trim() ?? "" : ""; const memberExternalId = mapping.memberId ? record[mapping.memberId]?.trim() || null : null; const notes = mapping.notes ? record[mapping.notes] ?? "" : "";
    if (contact.length > 300) issues.push({ row, message: "Contact must be 300 characters or fewer." });
    if (memberExternalId && memberExternalId.length > 200) issues.push({ row, message: "Member ID must be 200 characters or fewer." });
    if (notes.length > 4_000) issues.push({ row, message: "Notes must be 4,000 characters or fewer." });
    const importIdentity = memberExternalId ? `member:${memberExternalId.toLocaleLowerCase()}` : `person:${displayName.toLocaleLowerCase().replace(/\s+/g, " ")}|${contact.toLocaleLowerCase()}`;
    const priorRow = identities.get(importIdentity); if (priorRow) { issues.push({ row, message: `Duplicates the participant on row ${priorRow}.` }); return; } identities.set(importIdentity, row);
    if (importIdentity.length > 500) { issues.push({ row, message: "Participant identity is too long to import." }); return; }
    people.push({ importIdentity, displayName, contact, memberExternalId, sourceRow: row, outboundSourceStatus, outboundStatus, outboundAddress, outboundLatitude, outboundLongitude, outboundSeats, returnSourceStatus, returnStatus, returnAddress, returnLatitude, returnLongitude, returnSeats, returnSameAsOutbound: !mapping.returnAddress || !returnMapped, notes });
  });
  return { headers: parsed.headers, people, issues };
}

export function carpoolCsv(rows: readonly Record<string, unknown>[]) {
  if (!rows.length) return "";
  const escape = (value: unknown) => {
    let text = String(value ?? ""); if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const headers = Object.keys(rows[0]!);
  return [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\r\n");
}
