import { carpoolLocalTime, carpoolLocalInstant, validateCarpoolSchedule } from "../../../packages/shared/src/carpool-schedule";
import type { CivilTimeOccurrence } from "../../../packages/shared/src/civil-time";
import type { CarpoolGroupSetting } from "../../../packages/shared/src/carpool-groups";
import type { RelatedMeeting } from "./carpool-meeting-links";
import { carpoolReadiness, carpoolDirections, type CarpoolTripScope } from "../../../packages/shared/src/carpool-state";

export type Direction = "outbound" | "return";
export type Status = "offer" | "arranged" | "needs-ride" | "transit" | "unknown";
export type Stage = "event" | "locations" | "groups" | "map" | "export";
export type Plan = { timeZone?: string; outboundDepartureAt?: string | null; returnDepartureAt?: string | null; groupSettings?: CarpoolGroupSetting[]; rebuildUndo?: { revision: number; directions: Direction[] } | null; id: string; title: string; destination: string; tripScope?: CarpoolTripScope; meetingId?: string | null; eventReference: string | null; eventTitleSnapshot: string | null; eventStartsAtSnapshot: string | null; radiusMiles: number; preferredRadiusMiles: number; notes: string; archived: boolean; revision: number };
export type Person = { outboundLocationSource?: "lookup" | "manual" | "no-match" | null; outboundLocationLabel?: string | null; returnLocationSource?: "lookup" | "manual" | "no-match" | null; returnLocationLabel?: string | null; id: string; memberId: string | null; memberActive: boolean | null; displayName: string; contact: string; outboundSourceStatus: string | null; outboundStatus: Status; outboundAddress: string; outboundLatitude: number | null; outboundLongitude: number | null; outboundSeats: number | null; returnSourceStatus: string | null; returnStatus: Status; returnAddress: string; returnLatitude: number | null; returnLongitude: number | null; returnSeats: number | null; returnSameAsOutbound: boolean; notes: string; revision: number };
export type Assignment = { riderId: string; vehiclePersonId: string; direction: Direction; distanceMiles: number; locked: boolean; manual: boolean };
export type Unresolved = { riderId: string; direction: Direction; reason: string; detail: string };
export type LocationLookup = { inputKey: string; state: "unconfigured" | "queued" | "running" | "complete" | "failed"; remaining: number; errorCode?: string };
export type Detail = { plan: Plan; people: Person[]; assignments: Assignment[]; unresolved: Unresolved[]; locationLookup?: LocationLookup };
export type Member = { id: string; externalId: string; firstName: string; lastName: string; email: string | null };
export type Context = { plans: Plan[]; members: Member[]; importProfiles: Array<{ headerKey: string; mapping: Partial<ColumnMapping> }>; geocodingConfigured: boolean; locationLookup?: LocationLookup | null; defaults?: { radiusMiles: number; preferredRadiusMiles: number }; meetingReferencesAvailable?: boolean; meetingChoices?: RelatedMeeting[]; relatedMeeting?: RelatedMeeting | null; detail: Detail | null };
export type Notice = { tone: "success" | "error" | "warning"; message: string } | null;
export type Undo = { planId: string; label: string; direction: Direction; riderId: string; body: object; planRevision: number } | null;
export type RebuildPreview = { planRevision: number; previewToken: string; directions: Direction[]; radiusMiles: number; preferredRadiusMiles: number; assignments: Assignment[]; unresolved: Unresolved[]; changes: Array<{ direction: Direction; riderId: string; beforeVehiclePersonId: string | null; afterVehiclePersonId: string | null; change: string; locked: boolean }>; summary: Array<{ direction: Direction; assigned: number; exceptions: number; added: number; moved: number; removed: number; unchanged: number; lockedPreserved: number }> };
export type ImportPhase = "mapping" | "corrections";
export type ImportIssue = { rowIndex: number; header: string; message: string };

export const stages: Array<{ id: Stage; label: string }> = [
  { id: "event", label: "People" }, { id: "groups", label: "Groups" }, { id: "export", label: "Share" },
];
export const workArea = (stage: Stage) => stage === "event" || stage === "locations" ? "people" : stage === "export" ? "share" : "groups";
export function carpoolView(search: string): { stage: Stage; direction: Direction } {
  const query = new URLSearchParams(search); const area = query.get("area"); const view = query.get("view");
  return { stage: area === "share" ? "export" : area === "groups" ? view === "map" ? "map" : "groups" : view === "locations" ? "locations" : "event", direction: query.get("direction") === "return" ? "return" : "outbound" };
}
export function carpoolViewUrl(planId: string, stage: Stage, direction: Direction) {
  const query = new URLSearchParams({ area: workArea(stage), direction });
  if (stage === "locations" || stage === "map") query.set("view", stage);
  return `${planId ? `/carpool/plans/${encodeURIComponent(planId)}` : "/carpool"}?${query}`;
}
export const statuses: Array<[Status, string]> = [
  ["unknown", "Needs review"], ["needs-ride", "Needs a ride"], ["offer", "Can drive"],
  ["arranged", "Ride already arranged"], ["transit", "Independent transportation"],
];
export const statusLabel = (status: Status) => statuses.find(([value]) => value === status)?.[1] ?? status;
export const emptyPerson = (scope: CarpoolTripScope = "both") => ({ memberId: "", displayName: "", contact: "", outboundStatus: "unknown" as Status, outboundAddress: "", outboundLatitude: "", outboundLongitude: "", outboundSeats: "", returnStatus: "unknown" as Status, returnAddress: "", returnLatitude: "", returnLongitude: "", returnSeats: "", returnSameAsOutbound: scope !== "return", outboundLocationLookupKey: "", returnLocationLookupKey: "", outboundLocationConfirmed: false, returnLocationConfirmed: false, notes: "" });
export type PersonDraft = ReturnType<typeof emptyPerson>;
export type ParticipantDraft = { base: Person; value: PersonDraft };
export function updatePersonDraft(prior: PersonDraft, value: PersonDraft): PersonDraft {
  const next = { ...value };
  for (const trip of ["outbound", "return"] as const) {
    if (next[`${trip}Address`] !== prior[`${trip}Address`]) { next[`${trip}Latitude`] = ""; next[`${trip}Longitude`] = ""; next[`${trip}LocationLookupKey`] = ""; next[`${trip}LocationConfirmed`] = false; }
    else if ((next[`${trip}Latitude`] !== prior[`${trip}Latitude`] || next[`${trip}Longitude`] !== prior[`${trip}Longitude`]) && next[`${trip}LocationLookupKey`] === prior[`${trip}LocationLookupKey`]) { next[`${trip}LocationLookupKey`] = ""; next[`${trip}LocationConfirmed`] = true; }
  }
  return next;
}
export const emptyPlan = (defaults = { radiusMiles: 12, preferredRadiusMiles: 4 }) => ({ title: "", destination: "", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", outboundDepartureAt: "", returnDepartureAt: "", outboundOccurrence: "" as "" | CivilTimeOccurrence, returnOccurrence: "" as "" | CivilTimeOccurrence, eventOccurrence: "" as "" | CivilTimeOccurrence, tripScope: "both" as CarpoolTripScope, meetingId: "", eventReference: "", eventTitleSnapshot: "", eventStartsAtSnapshot: "", radiusMiles: String(defaults.radiusMiles), preferredRadiusMiles: String(defaults.preferredRadiusMiles), notes: "" });
export type PlanDraft = ReturnType<typeof emptyPlan>;
export type ColumnMapping = { name: string; contact: string; memberId: string; outboundStatus: string; outboundAddress: string; outboundLatitude: string; outboundLongitude: string; outboundSeats: string; returnStatus: string; returnAddress: string; returnLatitude: string; returnLongitude: string; returnSeats: string; notes: string };
export const emptyMapping = (): ColumnMapping => ({ name: "", contact: "", memberId: "", outboundStatus: "", outboundAddress: "", outboundLatitude: "", outboundLongitude: "", outboundSeats: "", returnStatus: "", returnAddress: "", returnLatitude: "", returnLongitude: "", returnSeats: "", notes: "" });
export const importMappingFields: Array<[keyof ColumnMapping, string, boolean]> = [
  ["name", "Name", true], ["contact", "Contact", false], ["memberId", "Member ID", false],
  ["outboundStatus", "Status there", true], ["outboundAddress", "Address", true], ["outboundSeats", "Available seats there", false], ["returnStatus", "Status back", true],
  ["returnAddress", "Return address", false],
  ["returnSeats", "Available seats back", false], ["notes", "Comments", false],
];
export const headerAliases: Record<keyof ColumnMapping, string[]> = {
  name: ["name", "participant", "student", "member name"], contact: ["contact", "contact info", "email", "phone"], memberId: ["member id", "memberid", "student id", "id"],
  outboundStatus: ["status there", "outbound status", "to event", "transportation there", "ride there"], outboundAddress: ["address", "outbound address", "home address", "pickup address"],
  outboundLatitude: ["latitude there", "outbound latitude", "latitude", "lat"], outboundLongitude: ["longitude there", "outbound longitude", "longitude", "lon", "lng"], outboundSeats: ["available seats there", "outbound seats", "seats there", "available seats"],
  returnStatus: ["status back", "return status", "from event", "transportation back", "ride back"], returnAddress: ["return address", "address back", "dropoff address"],
  returnLatitude: ["latitude back", "return latitude"], returnLongitude: ["longitude back", "return longitude"], returnSeats: ["available seats back", "return seats", "seats back"], notes: ["comments", "notes", "comment"],
};

export const numberOrNull = (value: string) => value.trim() ? Number(value) : null;
export const leg = (person: Person, direction: Direction) => direction === "outbound"
  ? { status: person.outboundStatus, address: person.outboundAddress, latitude: person.outboundLatitude, longitude: person.outboundLongitude, seats: person.outboundSeats }
  : { status: person.returnStatus, address: person.returnAddress, latitude: person.returnLatitude, longitude: person.returnLongitude, seats: person.returnSeats };
export const toPersonDraft = (person: Person): PersonDraft => ({ memberId: person.memberId ?? "", displayName: person.displayName, contact: person.contact, outboundStatus: person.outboundStatus, outboundAddress: person.outboundAddress, outboundLatitude: person.outboundLatitude?.toString() ?? "", outboundLongitude: person.outboundLongitude?.toString() ?? "", outboundSeats: person.outboundSeats?.toString() ?? "", returnStatus: person.returnStatus, returnAddress: person.returnAddress, returnLatitude: person.returnLatitude?.toString() ?? "", returnLongitude: person.returnLongitude?.toString() ?? "", returnSeats: person.returnSeats?.toString() ?? "", returnSameAsOutbound: person.returnSameAsOutbound, outboundLocationLookupKey: "", returnLocationLookupKey: "", outboundLocationConfirmed: false, returnLocationConfirmed: false, notes: person.notes });
export function toPlanDraft(plan: Plan): PlanDraft {
  const timeZone = plan.timeZone ?? "UTC"; const event = carpoolLocalTime(plan.eventStartsAtSnapshot, timeZone); const outbound = carpoolLocalTime(plan.outboundDepartureAt, timeZone); const returning = carpoolLocalTime(plan.returnDepartureAt, timeZone);
  return { title: plan.title, destination: plan.destination, timeZone, outboundDepartureAt: outbound.value, returnDepartureAt: returning.value, outboundOccurrence: outbound.occurrence, returnOccurrence: returning.occurrence, eventOccurrence: event.occurrence, tripScope: plan.tripScope ?? "both", meetingId: plan.meetingId ?? "", eventReference: plan.eventReference ?? "", eventTitleSnapshot: plan.eventTitleSnapshot ?? "", eventStartsAtSnapshot: event.value, radiusMiles: String(plan.radiusMiles), preferredRadiusMiles: String(plan.preferredRadiusMiles), notes: plan.notes };
}
export function changePlanTimeZone(value: PlanDraft, timeZone: string): PlanDraft {
  validateCarpoolSchedule({ timeZone });
  const convert = (local: string, occurrence: "" | CivilTimeOccurrence) => carpoolLocalTime(carpoolLocalInstant(local, value.timeZone, occurrence), timeZone);
  const event = convert(value.eventStartsAtSnapshot, value.eventOccurrence); const outbound = convert(value.outboundDepartureAt, value.outboundOccurrence); const returning = convert(value.returnDepartureAt, value.returnOccurrence);
  return { ...value, timeZone, eventStartsAtSnapshot: event.value, eventOccurrence: event.occurrence, outboundDepartureAt: outbound.value, outboundOccurrence: outbound.occurrence, returnDepartureAt: returning.value, returnOccurrence: returning.occurrence };
}

export function personPayload(value: PersonDraft, revision?: number) {
  return { ...value, memberId: value.memberId || null, outboundLatitude: numberOrNull(value.outboundLatitude), outboundLongitude: numberOrNull(value.outboundLongitude), outboundSeats: value.outboundStatus === "offer" ? numberOrNull(value.outboundSeats) : null, returnAddress: value.returnSameAsOutbound ? value.outboundAddress : value.returnAddress, returnLatitude: value.returnSameAsOutbound ? numberOrNull(value.outboundLatitude) : numberOrNull(value.returnLatitude), returnLongitude: value.returnSameAsOutbound ? numberOrNull(value.outboundLongitude) : numberOrNull(value.returnLongitude), returnLocationLookupKey: value.returnSameAsOutbound ? value.outboundLocationLookupKey : value.returnLocationLookupKey, returnLocationConfirmed: value.returnSameAsOutbound ? value.outboundLocationConfirmed : value.returnLocationConfirmed, returnSeats: value.returnStatus === "offer" ? numberOrNull(value.returnSeats) : null, ...(revision === undefined ? {} : { revision }) };
}
export function planPayload(value: PlanDraft, revision?: number, archived?: boolean) {
  const { outboundOccurrence, returnOccurrence, eventOccurrence, ...fields } = value;
  const schedule = validateCarpoolSchedule({ timeZone: value.timeZone, outboundDepartureAt: carpoolLocalInstant(value.outboundDepartureAt, value.timeZone, outboundOccurrence), returnDepartureAt: carpoolLocalInstant(value.returnDepartureAt, value.timeZone, returnOccurrence) }, value.tripScope);
  return { ...fields, ...schedule, meetingId: value.meetingId || null, eventReference: value.eventReference || null, eventTitleSnapshot: value.eventTitleSnapshot || null, eventStartsAtSnapshot: carpoolLocalInstant(value.eventStartsAtSnapshot, value.timeZone, eventOccurrence), radiusMiles: Number(value.radiusMiles), preferredRadiusMiles: Number(value.preferredRadiusMiles), ...(revision === undefined ? {} : { revision }), ...(archived === undefined ? {} : { archived }) };
}
export function needsReview(person: Person, direction: Direction) {
  const current = leg(person, direction);
  const sourceStatus = direction === "outbound" ? person.outboundSourceStatus : person.returnSourceStatus;
  if (current.status === "unknown") return sourceStatus ? `Imported response: "${sourceStatus}". Choose the closest status.` : "Transportation status needs review.";
  if (["offer", "needs-ride"].includes(current.status) && !current.address.trim()) return "A relevant address is required.";
  if (current.status === "offer" && (!Number.isInteger(current.seats) || (current.seats ?? -1) < 0)) return "Enter a whole-number spare seat count.";
  return "";
}
export function needsLocation(person: Person, direction: Direction) { const current = leg(person, direction); return ["offer", "needs-ride"].includes(current.status) && (current.latitude === null || current.longitude === null); }
export function addressNeedsLocality(value: string) { const address = value.trim(); return Boolean(address) && !/\b\d{5}(?:-\d{4})?\b/.test(address) && !/(?:^|[\s,])(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:[\s,]|$)/i.test(address) && address.split(",").filter((part) => part.trim()).length < 3; }
export function directionReady(detail: Detail, direction: Direction) {
  return carpoolReadiness(detail.people, detail.assignments, detail.unresolved, detail.plan.tripScope ?? "both").directions[direction].ready;
}
export function download(filename: string, content: string, type = "text/csv") { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function csvCell(value: string | number) { const text = String(value); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
export function csvText(headers: string[], records: Record<string, string>[], formulaSafe = false) {
  const cell = (value: string) => csvCell(formulaSafe && /^\s*[=+\-@]/.test(value) ? `'${value}` : value);
  return [headers, ...records.map((record) => headers.map((header) => record[header] ?? ""))].map((values) => values.map(cell).join(",")).join("\r\n");
}
export function correctedCsvFilename(filename: string) { const stem = filename.trim().replace(/\.csv$/i, "") || "carpool-import"; return `${stem}-corrected.csv`; }
export function parseCsv(text: string) {
  if (text.length > 2_000_000) throw new Error("CSV must be 2 MB or smaller.");
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) { const character = text[index]!; if (quoted) { if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; } else if (character === '"') quoted = false; else field += character; } else if (character === '"') quoted = true; else if (character === ",") { row.push(field); field = ""; } else if (character === "\n" || character === "\r") { if (character === "\r" && text[index + 1] === "\n") index += 1; row.push(field); field = ""; if (row.some(Boolean)) rows.push(row); row = []; } else field += character; }
  if (quoted) throw new Error("CSV contains an unfinished quoted field."); row.push(field); if (row.some(Boolean)) rows.push(row);
  if (rows.length > 501 || rows.some(row => row.length > 100 || row.some(cell => cell.length > 4000))) throw new Error("Import up to 500 participants, 100 columns, and 4,000 characters per cell.");
  const headers = rows.shift()?.map((value) => value.trim()) ?? []; if (!headers.length || new Set(headers).size !== headers.length || headers.some((header) => !header)) throw new Error("CSV needs one non-empty, unique header row.");
  return { headers, records: rows.map((values) => Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]))) as Record<string, string>[] };
}
export function suggestMapping(headers: string[]) { const normalized = new Map(headers.map((header) => [header.trim().toLocaleLowerCase(), header])); return Object.fromEntries((Object.keys(headerAliases) as Array<keyof ColumnMapping>).map(key => [key, headerAliases[key].map((alias) => normalized.get(alias)).find(Boolean) ?? ""])) as ColumnMapping; }
export function importStatus(value: string): Status {
  const normalized = value.trim().toLocaleLowerCase().replace(/[ _]+/g, "-");
  if (["offer", "offering", "driver", "driving", "can-drive", "arranged-with-seats", "getting-a-ride-and-can-bring-others"].includes(normalized)) return "offer";
  if (["arranged", "has-ride", "ride-arranged", "arranged-without-seats", "getting-a-ride-but-cannot-bring-others"].includes(normalized)) return "arranged";
  if (["needs-ride", "need-a-ride", "request", "rider"].includes(normalized)) return "needs-ride";
  if (["transit", "self", "self-arranged", "self-arranged-transit", "septa", "walk", "walking", "bike", "biking"].includes(normalized)) return "transit";
  return "unknown";
}
export function mappedImportHeaders(mapping: ColumnMapping) {
  return Object.values(mapping).filter((header, index, values) => Boolean(header) && values.indexOf(header) === index);
}
export function validateImportRows(rows: Record<string, string>[], mapping: ColumnMapping, scope: CarpoolTripScope = "both"): ImportIssue[] {
  const issues: ImportIssue[] = []; const identities = new Map<string, number>();
  const issue = (rowIndex: number, header: string, message: string) => { if (header) issues.push({ rowIndex, header, message }); };
  rows.forEach((row, rowIndex) => {
    const value = (key: keyof ColumnMapping) => mapping[key] ? row[mapping[key]] ?? "" : "";
    const name = value("name").trim(); const contact = value("contact").trim(); const memberId = value("memberId").trim(); const notes = value("notes");
    const outboundStatus = importStatus(value("outboundStatus")); const returnStatus = importStatus(value("returnStatus"));
    const outboundAddress = value("outboundAddress").trim(); const mappedReturnAddress = value("returnAddress").trim(); const returnAddress = mappedReturnAddress || outboundAddress;
    if (!name) issue(rowIndex, mapping.name, "Name is required."); else if (name.length > 150) issue(rowIndex, mapping.name, "Use 150 characters or fewer.");
    if (scope !== "return" && outboundStatus === "unknown" && !["", "unknown", "needs-review"].includes(value("outboundStatus").trim().toLocaleLowerCase().replaceAll(" ", "-"))) issue(rowIndex, mapping.outboundStatus, "Choose a recognized to-event response.");
    if (scope !== "outbound" && returnStatus === "unknown" && !["", "unknown", "needs-review"].includes(value("returnStatus").trim().toLocaleLowerCase().replaceAll(" ", "-"))) issue(rowIndex, mapping.returnStatus, "Choose a recognized from-event response.");
    if (scope !== "return" && ["offer", "needs-ride"].includes(outboundStatus) && !outboundAddress) issue(rowIndex, mapping.outboundAddress, "An address is required for this response.");
    if ((scope !== "return" || !mappedReturnAddress) && outboundAddress.length > 500) issue(rowIndex, mapping.outboundAddress, "Use 500 characters or fewer.");
    if (scope !== "outbound" && ["offer", "needs-ride"].includes(returnStatus) && !returnAddress) issue(rowIndex, mapping.returnAddress || mapping.outboundAddress, "A return address is required for this response.");
    if (scope !== "outbound" && returnAddress.length > 500) issue(rowIndex, mapping.returnAddress || mapping.outboundAddress, "Use 500 characters or fewer.");
    for (const [status, key] of [[outboundStatus, "outboundSeats"], [returnStatus, "returnSeats"]] as const) if (status === "offer" && (key === "outboundSeats" ? scope !== "return" : scope !== "outbound")) {
      const raw = value(key); const parsed = Number(raw); if (!raw.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > 99) issue(rowIndex, mapping[key], "Enter a whole number from 0 to 99.");
    }
    for (const [latitudeKey, longitudeKey, label] of [["outboundLatitude", "outboundLongitude", "To-event"], ["returnLatitude", "returnLongitude", "From-event"]] as const) {
      if (scope === "outbound" && latitudeKey === "returnLatitude" || scope === "return" && latitudeKey === "outboundLatitude" && mapping.returnAddress) continue;
      if (!mapping[latitudeKey] && !mapping[longitudeKey]) continue;
      const latitude = value(latitudeKey); const longitude = value(longitudeKey); const parsedLatitude = Number(latitude); const parsedLongitude = Number(longitude);
      if (latitude.trim() && (!Number.isFinite(parsedLatitude) || parsedLatitude < -90 || parsedLatitude > 90)) issue(rowIndex, mapping[latitudeKey], `${label} latitude must be between -90 and 90.`);
      if (longitude.trim() && (!Number.isFinite(parsedLongitude) || parsedLongitude < -180 || parsedLongitude > 180)) issue(rowIndex, mapping[longitudeKey], `${label} longitude must be between -180 and 180.`);
      if (Boolean(latitude.trim()) !== Boolean(longitude.trim())) issue(rowIndex, latitude.trim() ? mapping[longitudeKey] : mapping[latitudeKey], "Latitude and longitude must both be provided.");
    }
    if (contact.length > 300) issue(rowIndex, mapping.contact, "Use 300 characters or fewer.");
    if (memberId.length > 200) issue(rowIndex, mapping.memberId, "Use 200 characters or fewer.");
    if (notes.length > 4_000) issue(rowIndex, mapping.notes, "Use 4,000 characters or fewer.");
    if (name) { const identity = memberId ? `member:${memberId.toLocaleLowerCase()}` : `person:${name.toLocaleLowerCase().replace(/\s+/g, " ")}|${contact.toLocaleLowerCase()}`; const prior = identities.get(identity); if (prior !== undefined) issue(rowIndex, memberId ? mapping.memberId : mapping.name, `Duplicates row ${prior + 2}.`); else identities.set(identity, rowIndex); }
  });
  return issues;
}
