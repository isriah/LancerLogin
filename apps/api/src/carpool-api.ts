import { validateCarpoolSchedule } from "../../../packages/shared/src/carpool-schedule.ts";
import { buildCarpoolShare, carpoolShareRows, type CarpoolShareInput } from "../../../packages/shared/src/carpool-share.ts";
import { parseGroupSettings, validateGroupSettings, parseRebuildSnapshot, validateRebuildSnapshot, checkRebuildParticipants, proposeCarpoolRebuild, type DirectionalAssignment, type DirectionalIssue, type RebuildSnapshot } from "./carpool-rebuild.ts";
import { HttpError } from "./http-error.ts";
import { readCarpoolDefaults } from "./carpool-settings.ts";
import type { D1Database } from "./d1-usage.ts";
import { carpoolCsv, mapCarpoolCsv, type CarpoolColumnMapping } from "./carpool-csv.ts";
import { carpoolAddressNeedsLocality, normalizeCarpoolAddress, type CarpoolGeocodeBias, type CarpoolGeocodeTransport } from "./carpool-geocoding.ts";
import { legFor, moveCarpoolAssignment, suggestCarpoolPlan, swapCarpoolAssignments, type CarpoolAssignment, type CarpoolDirection, type CarpoolPerson, type CarpoolStatus } from "./carpool-planning.ts";
import { activeRosterIdentity, listActiveRosterIdentities } from "./core-roster-projection.ts";
import type { MeetingReferenceAccess } from "./attendance-meeting-reference.ts";
import { carpoolMeetingId, readCarpoolMeetingLinks, withCarpoolMeetingLink } from "./carpool-meeting-links.ts";
import { lookupCarpoolLocation } from "./carpool-location-lookup.ts";
import { carpoolReadiness, carpoolDirections, type CarpoolTripScope, type CarpoolStatePerson, type CarpoolStateAssignment, type CarpoolStateIssue } from "../../../packages/shared/src/carpool-state.ts";

type Row = Record<string, unknown>;
type LocationSource = "lookup" | "manual" | "no-match" | null;
class CarpoolImportError extends HttpError {
  readonly issues: Array<{ row: number; message: string }>;
  constructor(issues: Array<{ row: number; message: string }>) { super(422, "Some CSV rows need attention before they can be imported.", issues.slice(0, 10).map(issue => `Row ${issue.row}: ${issue.message}`)); this.issues = issues; }
}
type RouteResult = { status: number; body: unknown };
const installationId = "primary";
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, name: string, maximum: number, required = false) => { if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new HttpError(400, `Provide ${name}`); return value.trim(); };
const nullableText = (value: unknown, name: string, maximum: number) => value === null || value === undefined || value === "" ? null : text(value, name, maximum, true);
const number = (value: unknown, name: string, minimum: number, maximum: number) => { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new HttpError(400, `Provide ${name}`); return value; };
const nullableCoordinate = (value: unknown, name: string, minimum: number, maximum: number) => value === null || value === undefined || value === "" ? null : number(value, name, minimum, maximum);
const direction = (value: unknown): CarpoolDirection => { if (value !== "outbound" && value !== "return") throw new HttpError(400, "Choose outbound or return"); return value; };
const statuses = new Set<CarpoolStatus>(["offer", "arranged", "needs-ride", "transit", "unknown"]);
const status = (value: unknown, name: string): CarpoolStatus => { if (typeof value !== "string" || !statuses.has(value as CarpoolStatus)) throw new HttpError(400, `Choose ${name}`); return value as CarpoolStatus; };
const revision = (value: unknown) => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new HttpError(400, "Provide the current revision"); return Number(value); };
function reviewedPlanRevision(value: unknown, plan: Row) {
  const expected = object(value) && value.planRevision !== undefined ? revision(value.planRevision) : Number(plan.revision);
  if (expected !== Number(plan.revision)) throw new HttpError(409, "This plan changed. Refresh the saved plan before applying your changes.");
  return expected;
}
const audit = (db: D1Database, actor: string, action: string, target: string, metadata: object = {}) => db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), installationId, actor, action, "carpool_plan", target, JSON.stringify(metadata), new Date().toISOString());
async function guardedMutationBatch(db: D1Database, guards: ReturnType<D1Database["prepare"]>[], following: ReturnType<D1Database["prepare"]>[]) {
  const statements = guards.flatMap((guard) => [guard, db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','carpool-revision-conflict') END AS updated")]);
  try { return await db.batch([...statements, ...following]); }
  catch (error) { if (error instanceof Error && error.message.includes("carpool-revision-conflict")) throw new HttpError(409, "Record changed; reload before saving"); throw error; }
}

function serializePlan(row: Row, workspace = true) { const undo = workspace ? parseRebuildSnapshot(row.last_rebuild_json) : null; return { timeZone: row.time_zone ?? "UTC", outboundDepartureAt: row.outbound_departure_at ?? null, returnDepartureAt: row.return_departure_at ?? null, groupSettings: workspace ? parseGroupSettings(row.group_settings_json) : [], rebuildUndo: undo && undo.revision === row.revision ? { revision: undo.revision, directions: undo.directions } : null, id: row.id, title: row.title, destination: row.destination, tripScope: row.trip_scope ?? "both", meetingId: row.meeting_id ?? null, eventReference: row.event_reference, eventTitleSnapshot: row.event_title_snapshot, eventStartsAtSnapshot: row.event_starts_at_snapshot, radiusMiles: row.radius_miles, preferredRadiusMiles: row.preferred_radius_miles, notes: row.notes, archived: Boolean(row.archived), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }; }
function serializePerson(row: Row) { const snapshot = parsedImportSnapshot(row.import_snapshot_json); return { id: row.id, planId: row.plan_id, memberId: row.member_id, memberExternalId: row.member_external_id ?? null, memberActive: row.member_active === null || row.member_active === undefined ? null : Boolean(row.member_active), displayName: row.display_name, contact: row.contact, sourceRow: row.source_row, importIdentity: row.import_identity, importSourceMemberExternalId: row.import_source_member_external_id ?? null, importSnapshot: snapshot, outboundLocationSource: row.outbound_location_source ?? null, outboundLocationLabel: row.outbound_location_label ?? null, returnLocationSource: row.return_location_source ?? null, returnLocationLabel: row.return_location_label ?? null, outboundSourceStatus: snapshot?.outbound_source_status ?? null, outboundStatus: row.outbound_status, outboundAddress: row.outbound_address, outboundLatitude: row.outbound_lat, outboundLongitude: row.outbound_lon, outboundSeats: row.outbound_seats, returnSourceStatus: snapshot?.return_source_status ?? null, returnStatus: row.return_status, returnAddress: row.return_address, returnLatitude: row.return_lat, returnLongitude: row.return_lon, returnSeats: row.return_seats, returnSameAsOutbound: Boolean(row.return_same_as_outbound), notes: row.notes, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }; }
function serializeAssignment(row: Row) { return { riderId: row.rider_id, vehiclePersonId: row.vehicle_person_id, direction: row.direction, distanceMiles: row.distance_miles, locked: Boolean(row.locked), manual: Boolean(row.manual) }; }
function serializeUnresolved(row: Row) { return { riderId: row.rider_id, direction: row.direction, reason: row.reason, detail: row.detail }; }

type ImportSnapshot = {
  member_id: string | null; display_name: string; contact: string;
  outbound_source_status?: string;
  outbound_status: CarpoolStatus; outbound_address: string; outbound_lat: number | null; outbound_lon: number | null; outbound_seats: number | null;
  return_source_status?: string;
  return_status: CarpoolStatus; return_address: string; return_lat: number | null; return_lon: number | null; return_seats: number | null;
  return_same_as_outbound: number; notes: string;
};
function importSnapshot(person: ReturnType<typeof mapCarpoolCsv>["people"][number], memberId: string | null): ImportSnapshot {
  return { member_id: memberId, display_name: person.displayName, contact: person.contact, outbound_source_status: person.outboundSourceStatus, outbound_status: person.outboundStatus, outbound_address: person.outboundAddress, outbound_lat: person.outboundLatitude, outbound_lon: person.outboundLongitude, outbound_seats: person.outboundSeats, return_source_status: person.returnSourceStatus, return_status: person.returnStatus, return_address: person.returnAddress, return_lat: person.returnLatitude, return_lon: person.returnLongitude, return_seats: person.returnSeats, return_same_as_outbound: person.returnSameAsOutbound ? 1 : 0, notes: person.notes };
}
function parsedImportSnapshot(value: unknown): ImportSnapshot | null {
  if (typeof value !== "string") return null;
  try { const parsed = JSON.parse(value); return object(parsed) ? parsed as ImportSnapshot : null; } catch { return null; }
}
function mergeImportSnapshot(row: Row, incoming: ImportSnapshot, scope: CarpoolTripScope = "both") {
  const previous = parsedImportSnapshot(row.import_snapshot_json);
  for (const trip of ["outbound", "return"] as const) if (!carpoolDirections(scope).includes(trip)) {
    for (const suffix of ["status", "address", "lat", "lon", "seats"] as const) { const key = `${trip}_${suffix}` as const; (incoming as Record<string, unknown>)[key] = previous ? previous[key] : row[key]; }
    incoming[`${trip}_source_status`] = previous?.[`${trip}_source_status`] ?? "";
  }
  if (scope === "outbound") incoming.return_same_as_outbound = previous?.return_same_as_outbound ?? Number(row.return_same_as_outbound);
  const merged = { ...incoming };
  const mergedKeys = ["member_id", "display_name", "contact", "outbound_status", "outbound_address", "outbound_lat", "outbound_lon", "outbound_seats", "return_status", "return_address", "return_lat", "return_lon", "return_seats", "return_same_as_outbound", "notes"] as const;
  for (const key of mergedKeys) {
    if (!previous || row[key] !== previous[key]) (merged as Record<string, unknown>)[key] = row[key];
  }
  for (const direction of ["outbound", "return"] as const) {
    const address = `${direction}_address` as const; const latitude = `${direction}_lat` as const; const longitude = `${direction}_lon` as const;
    if (merged[address] !== row[address]) {
      const replacement = merged[address] === incoming[address] && incoming[latitude] !== null && incoming[longitude] !== null && (incoming[latitude] !== row[latitude] || incoming[longitude] !== row[longitude]);
      merged[latitude] = replacement ? incoming[latitude] : null; merged[longitude] = replacement ? incoming[longitude] : null;
    } else if (incoming[address] !== merged[address]) {
      merged[latitude] = row[latitude] as number | null; merged[longitude] = row[longitude] as number | null;
    }
  }
  if (merged.return_same_as_outbound === 1) { merged.return_address = merged.outbound_address; merged.return_lat = merged.outbound_lat; merged.return_lon = merged.outbound_lon; }
  const outboundUpdated = (["outbound_status", "outbound_address", "outbound_lat", "outbound_lon", "outbound_seats"] as const).some((key) => merged[key] !== row[key]);
  const returnUpdated = (["return_status", "return_address", "return_lat", "return_lon", "return_seats", "return_same_as_outbound"] as const).some((key) => merged[key] !== row[key]);
  return { merged, outboundUpdated, returnUpdated };
}

function importLocationMetadata(existing: Row | undefined, snapshot: ImportSnapshot) {
  const values: Row = {};
  for (const trip of ["outbound", "return"] as const) {
    const unchanged = existing && snapshot[`${trip}_address`] === existing[`${trip}_address`] && snapshot[`${trip}_lat`] === existing[`${trip}_lat`] && snapshot[`${trip}_lon`] === existing[`${trip}_lon`];
    values[`${trip}_location_source`] = unchanged ? existing[`${trip}_location_source`] ?? null : snapshot[`${trip}_lat`] === null ? null : "manual";
    values[`${trip}_location_label`] = unchanged ? existing[`${trip}_location_label`] ?? null : null;
  }
  return values;
}

async function prepareCarpoolImport(db: D1Database, planId: string, input: unknown) {
  const plan = await requirePlan(db, planId); reviewedPlanRevision(input, plan);
  if (!object(input) || typeof input.csv !== "string" || !object(input.mapping)) throw new HttpError(400, "Provide CSV contents and a column mapping");
  const scope = input.tripScope ?? plan.trip_scope ?? "both";
  if (!["both", "outbound", "return"].includes(String(scope)) || carpoolDirections(scope as CarpoolTripScope).some(trip => !carpoolDirections((plan.trip_scope ?? "both") as CarpoolTripScope).includes(trip))) throw new HttpError(400, "Choose an import direction included in this plan");
  let imported: ReturnType<typeof mapCarpoolCsv>;
  try { imported = mapCarpoolCsv(input.csv, input.mapping as CarpoolColumnMapping, scope as CarpoolTripScope); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "CSV could not be read"); }
  if (imported.issues.length) throw new CarpoolImportError(imported.issues);
  const [existingResult, rosterResult, assignmentResult] = await Promise.all([
    db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=?").bind(installationId, planId).all<Row>(), listActiveRosterIdentities(db, installationId),
    db.prepare("SELECT direction,rider_id,vehicle_person_id FROM carpool_assignments WHERE installation_id=? AND plan_id=?").bind(installationId, planId).all<Row>(),
  ]);
  const existingRows = existingResult.results ?? []; const roster = rosterResult.results ?? [];
  const rosterByExternalId = new Map(roster.map(member => [member.externalId.toLocaleLowerCase(), member]));
  const used = new Set<string>(); let added = 0; let updated = 0; let preserved = 0;
  const changes = imported.people.map(person => {
    const member = person.memberExternalId ? rosterByExternalId.get(person.memberExternalId.toLocaleLowerCase()) : undefined;
    const matches = existingRows.filter(row => row.import_identity === person.importIdentity || member && row.member_id === member.id || !person.memberExternalId && `person:${String(row.display_name).toLocaleLowerCase().replace(/\s+/g, " ")}|${String(row.contact).toLocaleLowerCase()}` === person.importIdentity);
    if (matches.length > 1 || matches[0] && used.has(String(matches[0].id))) throw new HttpError(422, "The import matches an ambiguous or repeated saved participant. Review names, contacts and roster links before importing.");
    const existing = matches[0]; if (existing) used.add(String(existing.id)); else added++;
    const incoming = importSnapshot(person, member?.id ?? null); if (existing && !member && person.memberExternalId) incoming.member_id = parsedImportSnapshot(existing.import_snapshot_json)?.member_id ?? existing.member_id as string | null; const merge = existing ? mergeImportSnapshot(existing, incoming, scope as CarpoolTripScope) : null;
    const previous = existing && parsedImportSnapshot(existing.import_snapshot_json);
    const staffPreserved = Boolean(existing && Object.keys(incoming).some(key => !key.endsWith("_source_status") && existing[key] !== incoming[key as keyof ImportSnapshot] && (!previous || existing[key] !== previous[key as keyof ImportSnapshot])));
    if (staffPreserved) preserved++;
    const changed = Boolean(existing && merge && Object.keys(merge.merged).some(key => key.endsWith("_source_status") ? merge.merged[key as keyof ImportSnapshot] !== previous?.[key as keyof ImportSnapshot] : merge.merged[key as keyof ImportSnapshot] !== existing[key]));
    if (changed) updated++;
    return { person, existing, incoming, merge, staffPreserved };
  });
  if (existingRows.length + added > 500) throw new HttpError(400, "A Carpool plan may contain at most 500 participants");
  const affected = (assignmentResult.results ?? []).filter(item => changes.some(change => change.existing && change.merge && (item.direction === "outbound" ? change.merge.outboundUpdated : change.merge.returnUpdated) && [item.rider_id, item.vehicle_person_id].includes(change.existing.id)));
  const tokenInput = JSON.stringify({ planId, revision: plan.revision, scope, csv: input.csv, mapping: input.mapping, roster: roster.map(member => [member.id, member.externalId]) });
  const previewToken = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenInput)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { plan, imported, existingRows, changes, previewToken, mapping: input.mapping, scope: scope as CarpoolTripScope, summary: { rows: imported.people.length, added, updated, unchanged: imported.people.length - added - updated, staffEditsPreserved: preserved, assignmentsNeedingReview: affected.length, unmatchedRosterIds: imported.people.filter(person => person.memberExternalId && !rosterByExternalId.has(person.memberExternalId.toLocaleLowerCase())).length } };
}
function backupImportSnapshot(value: unknown, memberId: string | null): string | null {
  if (value === null || value === undefined) return null;
  const keys = ["member_id", "display_name", "contact", "outbound_source_status", "outbound_status", "outbound_address", "outbound_lat", "outbound_lon", "outbound_seats", "return_source_status", "return_status", "return_address", "return_lat", "return_lon", "return_seats", "return_same_as_outbound", "notes"];
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new HttpError(400, "Carpool backup contains invalid import recovery data");
  const checked = personInput({ memberId, displayName: value.display_name, contact: value.contact, outboundStatus: value.outbound_status, outboundAddress: value.outbound_address, outboundLatitude: value.outbound_lat, outboundLongitude: value.outbound_lon, outboundSeats: value.outbound_seats, returnStatus: value.return_status, returnAddress: value.return_address, returnLatitude: value.return_lat, returnLongitude: value.return_lon, returnSeats: value.return_seats, returnSameAsOutbound: value.return_same_as_outbound === 1, notes: value.notes });
  const outboundSourceStatus = value.outbound_source_status === undefined ? "" : text(value.outbound_source_status, "an outbound source status", 4_000);
  const returnSourceStatus = value.return_source_status === undefined ? "" : text(value.return_source_status, "a return source status", 4_000);
  return JSON.stringify({ member_id: checked.memberId, display_name: checked.displayName, contact: checked.contact, outbound_source_status: outboundSourceStatus, outbound_status: checked.outboundStatus, outbound_address: checked.outboundAddress, outbound_lat: checked.outboundLatitude, outbound_lon: checked.outboundLongitude, outbound_seats: checked.outboundSeats, return_source_status: returnSourceStatus, return_status: checked.returnStatus, return_address: checked.returnAddress, return_lat: checked.returnLatitude, return_lon: checked.returnLongitude, return_seats: checked.returnSeats, return_same_as_outbound: checked.returnSameAsOutbound ? 1 : 0, notes: checked.notes } satisfies ImportSnapshot);
}

function planInput(value: unknown, existing?: Row) {
  if (!object(value) || Object.keys(value).some((key) => !["title", "destination", "meetingId", "eventReference", "eventTitleSnapshot", "eventStartsAtSnapshot", "radiusMiles", "preferredRadiusMiles", "notes", "archived", "revision", "tripScope", "timeZone", "outboundDepartureAt", "returnDepartureAt"].includes(key))) throw new HttpError(400, "Provide a Carpool plan");
  const tripScope = value.tripScope ?? existing?.trip_scope ?? "both"; if (!["both", "outbound", "return"].includes(String(tripScope))) throw new HttpError(400, "Choose which trip directions are planned");
  let schedule: ReturnType<typeof validateCarpoolSchedule>;
  try { schedule = validateCarpoolSchedule({ timeZone: value.timeZone === undefined ? existing?.time_zone : value.timeZone, outboundDepartureAt: value.outboundDepartureAt === undefined ? existing?.outbound_departure_at : value.outboundDepartureAt, returnDepartureAt: value.returnDepartureAt === undefined ? existing?.return_departure_at : value.returnDepartureAt }, tripScope as CarpoolTripScope); } catch (error) { throw new HttpError(400, (error as Error).message); }
  const radiusMiles = value.radiusMiles === undefined ? Number(existing?.radius_miles ?? 12) : number(value.radiusMiles, "a planning radius", 0.5, 250);
  const preferredRadiusMiles = value.preferredRadiusMiles === undefined ? Math.min(Number(existing?.preferred_radius_miles ?? 4), radiusMiles) : number(value.preferredRadiusMiles, "a preferred radius", 0.5, radiusMiles);
  const eventStartsAtSnapshot = nullableText(value.eventStartsAtSnapshot === undefined ? existing?.event_starts_at_snapshot : value.eventStartsAtSnapshot, "a valid event start snapshot", 50);
  if (eventStartsAtSnapshot && !Number.isFinite(Date.parse(eventStartsAtSnapshot))) throw new HttpError(400, "Provide a valid event start snapshot");
  if (value.archived !== undefined && typeof value.archived !== "boolean") throw new HttpError(400, "Archived must be true or false");
  return { ...schedule, tripScope: tripScope as CarpoolTripScope, title: text(value.title ?? existing?.title, "a plan title", 150, true), destination: text(value.destination ?? existing?.destination ?? "", "a destination", 300), meetingId: carpoolMeetingId(value.meetingId === undefined ? existing?.meeting_id : value.meetingId), eventReference: nullableText(value.eventReference === undefined ? existing?.event_reference : value.eventReference, "an event reference", 200), eventTitleSnapshot: nullableText(value.eventTitleSnapshot === undefined ? existing?.event_title_snapshot : value.eventTitleSnapshot, "an event title snapshot", 150), eventStartsAtSnapshot, radiusMiles, preferredRadiusMiles, notes: text(value.notes ?? existing?.notes ?? "", "plan notes", 4000), archived: value.archived === undefined ? Boolean(existing?.archived) : value.archived, revision: value.revision === undefined ? undefined : revision(value.revision) };
}

function personInput(value: unknown) {
  const allowed = ["memberId", "displayName", "contact", "outboundStatus", "outboundAddress", "outboundLatitude", "outboundLongitude", "outboundSeats", "returnStatus", "returnAddress", "returnLatitude", "returnLongitude", "returnSeats", "returnSameAsOutbound", "notes", "revision", "planRevision", "outboundLocationConfirmed", "returnLocationConfirmed", "outboundLocationLookupKey", "returnLocationLookupKey"];
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new HttpError(400, "Provide a Carpool participant");
  const outboundStatus = status(value.outboundStatus, "an outbound ride status"); const returnStatus = status(value.returnStatus, "a return ride status");
  const outboundLatitude = nullableCoordinate(value.outboundLatitude, "outbound latitude", -90, 90); const outboundLongitude = nullableCoordinate(value.outboundLongitude, "outbound longitude", -180, 180);
  const returnLatitude = nullableCoordinate(value.returnLatitude, "return latitude", -90, 90); const returnLongitude = nullableCoordinate(value.returnLongitude, "return longitude", -180, 180);
  if ((outboundLatitude === null) !== (outboundLongitude === null) || (returnLatitude === null) !== (returnLongitude === null)) throw new HttpError(400, "Latitude and longitude must be entered together");
  const outboundSeats = outboundStatus === "offer" ? number(value.outboundSeats, "outbound seats", 0, 99) : null;
  const returnSeats = returnStatus === "offer" ? number(value.returnSeats, "return seats", 0, 99) : null;
  if (!Number.isInteger(outboundSeats) && outboundSeats !== null || !Number.isInteger(returnSeats) && returnSeats !== null) throw new HttpError(400, "Seat counts must be whole numbers");
  if (typeof value.returnSameAsOutbound !== "boolean") throw new HttpError(400, "Choose whether return uses the outbound location");
  for (const key of ["outboundLocationConfirmed", "returnLocationConfirmed"]) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new HttpError(400, "Choose whether the updated location was verified");
  return { outboundLocationSource: null as LocationSource, outboundLocationLabel: null as string | null, returnLocationSource: null as LocationSource, returnLocationLabel: null as string | null, memberId: nullableText(value.memberId, "a roster member", 128), displayName: text(value.displayName, "a participant name", 150, true), contact: text(value.contact ?? "", "contact information", 300), outboundStatus, outboundAddress: text(value.outboundAddress ?? "", "an outbound address", 500), outboundLatitude, outboundLongitude, outboundSeats, returnStatus, returnAddress: text(value.returnAddress ?? "", "a return address", 500), returnLatitude, returnLongitude, returnSeats, returnSameAsOutbound: value.returnSameAsOutbound, notes: text(value.notes ?? "", "participant notes", 4000), revision: value.revision === undefined ? undefined : revision(value.revision) };
}

async function reconcileParticipantLocations(db: D1Database, value: ReturnType<typeof personInput>, raw: unknown, existing?: Row) {
  for (const direction of ["outbound", "return"] as const) {
    if (existing && value[`${direction}Address`] !== existing[`${direction}_address`] && value[`${direction}Latitude`] === existing[`${direction}_lat`] && value[`${direction}Longitude`] === existing[`${direction}_lon`] && !(object(raw) && raw[`${direction}LocationConfirmed`] === true)) {
      value[`${direction}Latitude`] = null; value[`${direction}Longitude`] = null;
    }
  }
  if (value.returnSameAsOutbound) { value.returnAddress = value.outboundAddress; value.returnLatitude = value.outboundLatitude; value.returnLongitude = value.outboundLongitude; }
  for (const trip of ["outbound", "return"] as const) {
    const unchanged = existing && value[`${trip}Address`] === existing[`${trip}_address`] && value[`${trip}Latitude`] === existing[`${trip}_lat`] && value[`${trip}Longitude`] === existing[`${trip}_lon`];
    let source = unchanged ? (existing[`${trip}_location_source`] ?? null) as LocationSource : value[`${trip}Latitude`] === null ? null : "manual" as LocationSource;
    let label = unchanged ? (existing[`${trip}_location_label`] ?? null) as string | null : null;
    const lookupKey = object(raw) ? nullableText(raw[`${trip}LocationLookupKey`], "a location lookup reference", 1000) : null;
    if (lookupKey) {
      const cached = await db.prepare("SELECT status,normalized_address,latitude,longitude,label,expires_at FROM carpool_location_cache WHERE installation_id=? AND cache_key=?").bind(installationId, lookupKey).first<Row>();
      if (!cached || cached.expires_at && Date.parse(String(cached.expires_at)) <= Date.now() || cached.normalized_address !== normalizeCarpoolAddress(value[`${trip}Address`]) || cached.latitude !== value[`${trip}Latitude`] || cached.longitude !== value[`${trip}Longitude`]) throw new HttpError(409, "The located address no longer matches this draft. Locate it again or enter a manual pin.");
      source = cached.status === "no-match" ? "no-match" : "lookup"; label = cached.label === null ? null : String(cached.label);
    }
    value[`${trip}LocationSource`] = source; value[`${trip}LocationLabel`] = label;
  }
  if (value.returnSameAsOutbound) { value.returnLocationSource = value.outboundLocationSource; value.returnLocationLabel = value.outboundLocationLabel; }
  return value;
}

async function requirePlan(db: D1Database, planId: string) {
  const row = await db.prepare("SELECT * FROM carpool_plans WHERE installation_id=? AND id=?").bind(installationId, planId).first<Row>();
  if (!row) throw new HttpError(404, "Carpool plan not found"); return row;
}

async function planDetail(db: D1Database, planId: string) {
  const plan = await requirePlan(db, planId);
  const [people, assignments, unresolved] = await Promise.all([
    db.prepare("SELECT carpool_people.*,current_member.external_id AS member_external_id,current_member.active AS member_active,source_member.external_id AS import_source_member_external_id FROM carpool_people LEFT JOIN members current_member ON current_member.installation_id=carpool_people.installation_id AND current_member.id=carpool_people.member_id LEFT JOIN members source_member ON source_member.installation_id=carpool_people.installation_id AND source_member.id=json_extract(carpool_people.import_snapshot_json,'$.member_id') WHERE carpool_people.installation_id=? AND carpool_people.plan_id=? ORDER BY carpool_people.display_name,carpool_people.id").bind(installationId, planId).all<Row>(),
    db.prepare("SELECT * FROM carpool_assignments WHERE installation_id=? AND plan_id=? ORDER BY direction,vehicle_person_id,rider_id").bind(installationId, planId).all<Row>(),
    db.prepare("SELECT * FROM carpool_unresolved WHERE installation_id=? AND plan_id=? ORDER BY direction,rider_id").bind(installationId, planId).all<Row>(),
  ]);
  const detail = { plan: serializePlan(plan), people: (people.results ?? []).map(serializePerson), assignments: (assignments.results ?? []).map(serializeAssignment), unresolved: (unresolved.results ?? []).map(serializeUnresolved) };
  return { ...detail, readiness: carpoolReadiness(detail.people as CarpoolStatePerson[], detail.assignments as CarpoolStateAssignment[], detail.unresolved as CarpoolStateIssue[], detail.plan.tripScope as CarpoolTripScope) };
}

export async function createCarpoolPlan(db: D1Database, actor: string, value: unknown, meetingAccess?: MeetingReferenceAccess) {
  const defaults = await readCarpoolDefaults(db);
  const input = planInput(value, { radius_miles: defaults.radiusMiles, preferred_radius_miles: defaults.preferredRadiusMiles }); const id = crypto.randomUUID(); const now = new Date().toISOString();
  const results = await withCarpoolMeetingLink(db, null, input.meetingId, meetingAccess, (authorized) => authorized.batch([
    authorized.prepare("INSERT INTO carpool_plans(installation_id,id,title,destination,event_reference,event_title_snapshot,event_starts_at_snapshot,radius_miles,preferred_radius_miles,notes,archived,revision,created_by,created_at,updated_at,meeting_id,trip_scope,time_zone,outbound_departure_at,return_departure_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, id, input.title, input.destination, input.eventReference, input.eventTitleSnapshot, input.eventStartsAtSnapshot, input.radiusMiles, input.preferredRadiusMiles, input.notes, input.archived ? 1 : 0, 0, actor, now, now, input.meetingId, input.tripScope, input.timeZone, input.outboundDepartureAt, input.returnDepartureAt),
    audit(authorized, actor, "carpool.plan_created", id),
  ]));
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Carpool plan could not be created");
  return planDetail(db, id);
}

function toPlanningPerson(row: Row): CarpoolPerson { return { id: String(row.id), displayName: String(row.display_name), outbound: { status: row.outbound_status as CarpoolStatus, address: String(row.outbound_address), latitude: row.outbound_lat === null ? null : Number(row.outbound_lat), longitude: row.outbound_lon === null ? null : Number(row.outbound_lon), seats: row.outbound_seats === null ? null : Number(row.outbound_seats) }, return: { status: row.return_status as CarpoolStatus, address: String(row.return_address), latitude: row.return_lat === null ? null : Number(row.return_lat), longitude: row.return_lon === null ? null : Number(row.return_lon), seats: row.return_seats === null ? null : Number(row.return_seats) } }; }
function toPlanningAssignment(row: Row): CarpoolAssignment { return { riderId: String(row.rider_id), vehiclePersonId: String(row.vehicle_person_id), distanceMiles: Number(row.distance_miles), locked: Boolean(row.locked), manual: Boolean(row.manual) }; }

async function prepareRebuild(db: D1Database, planId: string, requestedDirection: CarpoolDirection | "both", input?: unknown, strict = false) {
  const plan = await requirePlan(db, planId);
  if (strict && (!object(input) || input.planRevision === undefined || Object.keys(input).some(key => !["planRevision", "direction", "radiusMiles", "preferredRadiusMiles", "previewToken"].includes(key)))) throw new HttpError(400, "Provide a reviewed plan revision and rebuild settings");
  const expected = reviewedPlanRevision(input, plan);
  const settings = planInput(object(input) ? { radiusMiles: input.radiusMiles ?? Number(plan.radius_miles), preferredRadiusMiles: input.preferredRadiusMiles ?? Number(plan.preferred_radius_miles) } : {}, plan);
  const directions: CarpoolDirection[] = requestedDirection === "both" ? carpoolDirections(settings.tripScope) : [requestedDirection];
  if (directions.some(trip => !carpoolDirections(settings.tripScope).includes(trip))) throw new HttpError(400, "That trip direction is not planned for this event");
  const [peopleResult, assignmentResult, unresolvedResult] = await Promise.all([
    db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? ORDER BY id").bind(installationId, planId).all<Row>(),
    db.prepare("SELECT * FROM carpool_assignments WHERE installation_id=? AND plan_id=? ORDER BY direction,rider_id").bind(installationId, planId).all<Row>(),
    db.prepare("SELECT * FROM carpool_unresolved WHERE installation_id=? AND plan_id=? ORDER BY direction,rider_id").bind(installationId, planId).all<Row>(),
  ]);
  const people = (peopleResult.results ?? []).map(toPlanningPerson);
  const existing = (assignmentResult.results ?? []).map(row => ({ ...toPlanningAssignment(row), direction: direction(row.direction) }));
  const previousIssues = (unresolvedResult.results ?? []).map(row => ({ riderId: String(row.rider_id), direction: direction(row.direction), reason: row.reason, detail: row.detail }));
  const proposal = proposeCarpoolRebuild({ people, assignments: existing, directions, radiusMiles: settings.radiusMiles, preferredRadiusMiles: settings.preferredRadiusMiles });
  const snapshot = validateRebuildSnapshot({ version: 1, revision: expected + 1, directions, radiusMiles: Number(plan.radius_miles), preferredRadiusMiles: Number(plan.preferred_radius_miles), assignments: existing.filter(item => directions.includes(item.direction)), unresolved: previousIssues.filter(item => directions.includes(item.direction)) });
  const tokenInput = JSON.stringify({ planId, revision: expected, directions, radiusMiles: settings.radiusMiles, preferredRadiusMiles: settings.preferredRadiusMiles, proposal });
  const previewToken = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenInput)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { plan, expected, settings, directions, people, proposal, snapshot, previewToken };
}
function rebuildWrites(db: D1Database, planId: string, directions: CarpoolDirection[], assignments: DirectionalAssignment[], unresolved: DirectionalIssue[], now: string) {
  return directions.flatMap(trip => [
    db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, trip),
    db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, trip),
    ...assignments.filter(item => item.direction === trip).map(item => db.prepare("INSERT INTO carpool_assignments(installation_id,plan_id,direction,rider_id,vehicle_person_id,distance_miles,locked,manual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, trip, item.riderId, item.vehiclePersonId, item.distanceMiles, item.locked ? 1 : 0, item.manual ? 1 : 0, now, now)),
    ...unresolved.filter(item => item.direction === trip).map(item => db.prepare("INSERT INTO carpool_unresolved(installation_id,plan_id,direction,rider_id,reason,detail,created_at) VALUES(?,?,?,?,?,?,?)").bind(installationId, planId, trip, item.riderId, item.reason, item.detail, now)),
  ]);
}
async function applyRebuild(db: D1Database, actor: string, planId: string, prepared: Awaited<ReturnType<typeof prepareRebuild>>) {
  const { expected, settings, directions, proposal, snapshot } = prepared; const now = new Date().toISOString();
  await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET radius_miles=?,preferred_radius_miles=?,last_rebuild_json=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(settings.radiusMiles, settings.preferredRadiusMiles, JSON.stringify(snapshot), now, installationId, planId, expected)], [
    ...rebuildWrites(db, planId, directions, proposal.assignments, proposal.unresolved, now), audit(db, actor, "carpool.plan_generated", planId, { directions, assignments: proposal.assignments.length, unresolved: proposal.unresolved.length }),
  ]);
  return planDetail(db, planId);
}
async function generate(db: D1Database, actor: string, planId: string, requestedDirection: CarpoolDirection | "both", input?: unknown) {
  return applyRebuild(db, actor, planId, await prepareRebuild(db, planId, requestedDirection, input));
}
async function undoRebuild(db: D1Database, actor: string, planId: string, input: unknown) {
  const plan = await requirePlan(db, planId); if (!object(input) || input.planRevision === undefined || Object.keys(input).some(key => key !== "planRevision")) throw new HttpError(400, "Provide the reviewed rebuild revision"); reviewedPlanRevision(input, plan);
  const snapshot = parseRebuildSnapshot(plan.last_rebuild_json);
  if (!snapshot || snapshot.revision !== plan.revision) throw new HttpError(409, "The plan changed after the rebuild. Its previous groups can no longer be restored.");
  if (snapshot.directions.some(trip => !carpoolDirections((plan.trip_scope ?? "both") as CarpoolTripScope).includes(trip))) throw new HttpError(409, "The planned directions changed after the rebuild");
  const people = (await db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? ORDER BY id").bind(installationId, planId).all<Row>()).results ?? []; checkRebuildParticipants(snapshot, people.map(toPlanningPerson)); const now = new Date().toISOString();
  await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET radius_miles=?,preferred_radius_miles=?,last_rebuild_json=NULL,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(snapshot.radiusMiles, snapshot.preferredRadiusMiles, now, installationId, planId, plan.revision)], [
    ...rebuildWrites(db, planId, snapshot.directions, snapshot.assignments, snapshot.unresolved, now), audit(db, actor, "carpool.rebuild_undone", planId, { directions: snapshot.directions }),
  ]);
  return planDetail(db, planId);
}

async function assignmentAction(db: D1Database, actor: string, planId: string, selectedDirection: CarpoolDirection, riderId: string, value: unknown) {
  if (!object(value) || !["lock", "lock-car", "move", "swap", "unassign"].includes(String(value.action))) throw new HttpError(400, "Choose an assignment action");
  const plan = await requirePlan(db, planId); const now = new Date().toISOString();
  reviewedPlanRevision(value, plan);
  if (!carpoolDirections((plan.trip_scope ?? "both") as CarpoolTripScope).includes(selectedDirection)) throw new HttpError(400, "That trip direction is not planned for this event");
  if (value.action === "lock-car") {
    if (typeof value.locked !== "boolean") throw new HttpError(400, "Choose locked or unlocked");
    const vehicle = await db.prepare("SELECT id FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, riderId).first<Row>();
    if (!vehicle) throw new HttpError(404, "Car not found");
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [db.prepare("UPDATE carpool_assignments SET locked=?,updated_at=? WHERE installation_id=? AND plan_id=? AND direction=? AND vehicle_person_id=?").bind(value.locked ? 1 : 0, now, installationId, planId, selectedDirection, riderId), audit(db, actor, "carpool.car_lock", planId, { direction: selectedDirection, vehiclePersonId: riderId })]);
    return planDetail(db, planId);
  } else if (value.action === "lock") {
    if (typeof value.locked !== "boolean") throw new HttpError(400, "Choose locked or unlocked");
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision), db.prepare("UPDATE carpool_assignments SET locked=?,updated_at=? WHERE installation_id=? AND plan_id=? AND direction=? AND rider_id=?").bind(value.locked ? 1 : 0, now, installationId, planId, selectedDirection, riderId)], [audit(db, actor, "carpool.assignment_lock", planId, { direction: selectedDirection, riderId })]);
    return planDetail(db, planId);
  } else {
    const peopleRows = (await db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? ORDER BY id").bind(installationId, planId).all<Row>()).results ?? [];
    const rows = (await db.prepare("SELECT * FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection).all<Row>()).results ?? [];
    const current = rows.map(toPlanningAssignment); let next: CarpoolAssignment[] | undefined; let error: string | undefined;
    if (value.action === "unassign") { const existing = current.find(item => item.riderId === riderId); if (!existing || existing.locked) error = "Unlock an existing assignment before removing it."; else next = current.filter(item => item.riderId !== riderId); }
    else if (value.action === "move") ({ assignments: next, error } = moveCarpoolAssignment({ people: peopleRows.map(toPlanningPerson), direction: selectedDirection, assignments: current, riderId, vehiclePersonId: text(value.vehiclePersonId, "a car", 128, true) }));
      else ({ assignments: next, error } = swapCarpoolAssignments({ people: peopleRows.map(toPlanningPerson), direction: selectedDirection, assignments: current, firstRiderId: riderId, secondRiderId: text(value.secondRiderId, "another assigned rider", 128, true) }));
    if (error || !next) throw new HttpError(409, error ?? "Assignment could not be changed");
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection), ...next.map((item) => db.prepare("INSERT INTO carpool_assignments(installation_id,plan_id,direction,rider_id,vehicle_person_id,distance_miles,locked,manual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, selectedDirection, item.riderId, item.vehiclePersonId, item.distanceMiles, item.locked ? 1 : 0, item.manual ? 1 : 0, now, now)), ...next.map(item => db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction=? AND rider_id=?").bind(installationId, planId, selectedDirection, item.riderId)), audit(db, actor, `carpool.assignment_${String(value.action)}`, planId, { direction: selectedDirection, riderId })]);
    return planDetail(db, planId);
  }
}

async function exportPlan(db: D1Database, planId: string, kind: string) {
  const detail = await planDetail(db, planId); const people = new Map(detail.people.map((person) => [String(person.id), person]));
  if (kind === "backup") return { format: "lancerlogin-carpool-plan", schemaVersion: 4, exportedAt: new Date().toISOString(), ...detail, plan: { ...detail.plan, meetingId: null, rebuildUndo: null }, people: detail.people.map((person) => ({ ...person, memberId: null, importSnapshot: person.importSnapshot ? { ...person.importSnapshot, member_id: null } : null })) };
  if (kind === "unresolved") return { filename: `${String(detail.plan.title).replace(/[^a-z0-9]+/gi, "-").toLocaleLowerCase()}-unassigned.csv`, content: carpoolCsv([...detail.readiness.directions.outbound.issues, ...detail.readiness.directions.return.issues].map((item) => { const person = people.get(String(item.riderId))!; return { Direction: item.direction === "outbound" ? "To event" : "From event", Name: person?.displayName ?? item.riderId, Contact: person?.contact ?? "", Reason: item.reason, Detail: item.detail }; })) };
  const selectedDirection = direction(kind); if (!carpoolDirections(detail.plan.tripScope as CarpoolTripScope).includes(selectedDirection)) throw new HttpError(400, "That trip direction is not planned for this event"); const assignments = detail.assignments.filter((item) => item.direction === selectedDirection);
  return { filename: `${String(detail.plan.title).replace(/[^a-z0-9]+/gi, "-").toLocaleLowerCase()}-${selectedDirection}.csv`, content: carpoolCsv(assignments.map((item) => { const rider = people.get(String(item.riderId))!; const vehicle = people.get(String(item.vehiclePersonId))!; return { Direction: selectedDirection === "outbound" ? "To event" : "From event", Driver: vehicle?.displayName ?? item.vehiclePersonId, "Driver contact": vehicle?.contact ?? "", Rider: rider?.displayName ?? item.riderId, "Rider contact": rider?.contact ?? "", "Straight-line distance (miles)": Number(item.distanceMiles).toFixed(2), Locked: item.locked ? "Yes" : "No" }; })) };
}

async function restorePlan(db: D1Database, actor: string, value: unknown) {
  if (!object(value) || value.format !== "lancerlogin-carpool-plan" || ![1, 2, 3, 4].includes(Number(value.schemaVersion)) || !object(value.plan) || !Array.isArray(value.people) || !Array.isArray(value.assignments) || !Array.isArray(value.unresolved)) throw new HttpError(400, "This is not a supported Carpool plan backup");
  if (value.people.length > 500 || value.assignments.length > 1_000 || value.unresolved.length > 1_000) throw new HttpError(400, "Carpool backup is too large for plan restore");
  const sourcePlan = value.plan; if (value.schemaVersion === 4 && ["timeZone", "outboundDepartureAt", "returnDepartureAt"].some(key => !Object.hasOwn(sourcePlan, key))) throw new HttpError(400, "Carpool backup is missing trip timing"); if (Number(value.schemaVersion) >= 2 && !["both", "outbound", "return"].includes(String(sourcePlan.tripScope))) throw new HttpError(400, "Carpool backup is missing its trip scope"); const restoredPlan = planInput({ title: sourcePlan.title, destination: sourcePlan.destination, eventReference: sourcePlan.eventReference, eventTitleSnapshot: sourcePlan.eventTitleSnapshot, eventStartsAtSnapshot: sourcePlan.eventStartsAtSnapshot, radiusMiles: sourcePlan.radiusMiles, preferredRadiusMiles: sourcePlan.preferredRadiusMiles, notes: sourcePlan.notes, archived: false, tripScope: value.schemaVersion === 1 ? "both" : sourcePlan.tripScope, timeZone: Object.hasOwn(sourcePlan, "timeZone") ? sourcePlan.timeZone : "UTC", outboundDepartureAt: sourcePlan.outboundDepartureAt ?? null, returnDepartureAt: sourcePlan.returnDepartureAt ?? null });
  const roster = await listActiveRosterIdentities(db, installationId); const activeRosterByExternalId = new Map((roster.results ?? []).map((member) => [member.externalId.toLocaleLowerCase(), member.id]));
  const planId = crypto.randomUUID(); const now = new Date().toISOString(); const people = new Map<string, { id: string; value: ReturnType<typeof personInput>; sourceRow: number | null; importIdentity: string | null; importSnapshotJson: string | null }>(); const importIdentities = new Set<string>();
  for (const item of value.people) {
    if (!object(item) || typeof item.id !== "string" || !item.id || people.has(item.id)) throw new HttpError(400, "Carpool backup contains an invalid participant");
    const currentMemberId = typeof item.memberExternalId === "string" ? activeRosterByExternalId.get(item.memberExternalId.toLocaleLowerCase()) ?? null : null; const sourceMemberId = typeof item.importSourceMemberExternalId === "string" ? activeRosterByExternalId.get(item.importSourceMemberExternalId.toLocaleLowerCase()) ?? null : null;
    const person = personInput({ memberId: currentMemberId, displayName: item.displayName, contact: item.contact, outboundStatus: item.outboundStatus, outboundAddress: item.outboundAddress, outboundLatitude: item.outboundLatitude, outboundLongitude: item.outboundLongitude, outboundSeats: item.outboundSeats, returnStatus: item.returnStatus, returnAddress: item.returnAddress, returnLatitude: item.returnLatitude, returnLongitude: item.returnLongitude, returnSeats: item.returnSeats, returnSameAsOutbound: item.returnSameAsOutbound, notes: item.notes });
    for (const trip of ["outbound", "return"] as const) {
      const source = item[`${trip}LocationSource`] ?? null; const label = item[`${trip}LocationLabel`] ?? null;
      if (source !== null && !["lookup", "manual", "no-match"].includes(String(source)) || label !== null && (typeof label !== "string" || label.length > 500) || source === "no-match" && person[`${trip}Latitude`] !== null || ["lookup", "manual"].includes(String(source)) && person[`${trip}Latitude`] === null) throw new HttpError(400, "Carpool backup contains invalid location provenance");
      person[`${trip}LocationSource`] = source as LocationSource; person[`${trip}LocationLabel`] = label as string | null;
    }
    const sourceRow = item.sourceRow === null || item.sourceRow === undefined ? null : Number(item.sourceRow); if (sourceRow !== null && (!Number.isSafeInteger(sourceRow) || sourceRow < 1)) throw new HttpError(400, "Carpool backup contains invalid import recovery data");
    let importIdentity = item.importIdentity === null || item.importIdentity === undefined ? null : nullableText(item.importIdentity, "an import identity", 500); let importSnapshotJson = backupImportSnapshot(item.importSnapshot, sourceMemberId);
    if (!importIdentity || !importSnapshotJson) { importIdentity = null; importSnapshotJson = null; }
    if (importIdentity && importIdentities.has(importIdentity)) throw new HttpError(400, "Carpool backup contains duplicate import identities"); if (importIdentity) importIdentities.add(importIdentity);
    people.set(item.id, { id: item.id, value: person, sourceRow, importIdentity, importSnapshotJson });
  }
  const assignments = value.assignments.map((item) => { if (!object(item) || !people.has(String(item.riderId)) || !people.has(String(item.vehiclePersonId)) || item.riderId === item.vehiclePersonId || typeof item.locked !== "boolean" || typeof item.manual !== "boolean") throw new HttpError(400, "Carpool backup contains an invalid assignment"); return { riderId: String(item.riderId), vehiclePersonId: String(item.vehiclePersonId), direction: direction(item.direction), distanceMiles: number(item.distanceMiles, "assignment distance", 0, 25_000), locked: item.locked, manual: item.manual }; });
  if (new Set(assignments.map((item) => `${item.direction}:${item.riderId}`)).size !== assignments.length) throw new HttpError(400, "Carpool backup contains duplicate assignments");
  const unresolved = value.unresolved.map((item) => { if (!object(item) || !people.has(String(item.riderId)) || !["needs-review", "seat-shortage", "no-nearby-car", "no-nearby-seat"].includes(String(item.reason))) throw new HttpError(400, "Carpool backup contains an invalid unresolved ride"); return { riderId: String(item.riderId), direction: direction(item.direction), reason: String(item.reason), detail: text(item.detail, "an unresolved ride explanation", 500, true) }; });
  if (new Set(unresolved.map((item) => `${item.direction}:${item.riderId}`)).size !== unresolved.length) throw new HttpError(400, "Carpool backup contains duplicate unresolved rides");
  const assignmentKeys = new Set(assignments.map((item) => `${item.direction}:${item.riderId}`)); if (unresolved.some((item) => assignmentKeys.has(`${item.direction}:${item.riderId}`))) throw new HttpError(400, "A rider cannot be assigned and unresolved in the same direction");
  for (const item of assignments) { const rider = people.get(item.riderId)!.value; const vehicle = people.get(item.vehiclePersonId)!.value; const riderStatus = item.direction === "outbound" ? rider.outboundStatus : rider.returnStatus; const vehicleStatus = item.direction === "outbound" ? vehicle.outboundStatus : vehicle.returnStatus; if (riderStatus !== "needs-ride" || vehicleStatus !== "offer") throw new HttpError(400, "Carpool backup assigns an ineligible rider or car"); }
  for (const selectedDirection of ["outbound", "return"] as const) for (const { id, value: vehicle } of people.values()) { const seats = selectedDirection === "outbound" ? vehicle.outboundSeats : vehicle.returnSeats; const used = assignments.filter((item) => item.direction === selectedDirection && item.vehiclePersonId === id).length; if (used > (seats ?? 0)) throw new HttpError(400, "Carpool backup exceeds a car's capacity"); }
  const groupSettings = validateGroupSettings(Number(value.schemaVersion) >= 3 ? sourcePlan.groupSettings : sourcePlan.groupSettings ?? [], new Set(people.keys()));
  const statements = [db.prepare("INSERT INTO carpool_plans(installation_id,id,title,destination,event_reference,event_title_snapshot,event_starts_at_snapshot,radius_miles,preferred_radius_miles,notes,archived,revision,created_by,created_at,updated_at,trip_scope,group_settings_json,time_zone,outbound_departure_at,return_departure_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, restoredPlan.title, restoredPlan.destination, restoredPlan.eventReference, restoredPlan.eventTitleSnapshot, restoredPlan.eventStartsAtSnapshot, restoredPlan.radiusMiles, restoredPlan.preferredRadiusMiles, restoredPlan.notes, 0, 0, actor, now, now, restoredPlan.tripScope, JSON.stringify(groupSettings), restoredPlan.timeZone, restoredPlan.outboundDepartureAt, restoredPlan.returnDepartureAt), ...[...people.values()].map(({ id, value: person, sourceRow, importIdentity, importSnapshotJson }) => db.prepare("INSERT INTO carpool_people(installation_id,plan_id,id,member_id,display_name,contact,source_row,import_identity,import_snapshot_json,outbound_status,outbound_address,outbound_lat,outbound_lon,outbound_seats,return_status,return_address,return_lat,return_lon,return_seats,return_same_as_outbound,notes,revision,created_at,updated_at,outbound_location_source,outbound_location_label,return_location_source,return_location_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, id, person.memberId, person.displayName, person.contact, sourceRow, importIdentity, importSnapshotJson, person.outboundStatus, person.outboundAddress, person.outboundLatitude, person.outboundLongitude, person.outboundSeats, person.returnStatus, person.returnAddress, person.returnLatitude, person.returnLongitude, person.returnSeats, person.returnSameAsOutbound ? 1 : 0, person.notes, 0, now, now, person.outboundLocationSource, person.outboundLocationLabel, person.returnLocationSource, person.returnLocationLabel)), ...assignments.map((item) => db.prepare("INSERT INTO carpool_assignments(installation_id,plan_id,direction,rider_id,vehicle_person_id,distance_miles,locked,manual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, item.direction, item.riderId, item.vehiclePersonId, item.distanceMiles, item.locked ? 1 : 0, item.manual ? 1 : 0, now, now)), ...unresolved.map((item) => db.prepare("INSERT INTO carpool_unresolved(installation_id,plan_id,direction,rider_id,reason,detail,created_at) VALUES(?,?,?,?,?,?,?)").bind(installationId, planId, item.direction, item.riderId, item.reason, item.detail, now)), audit(db, actor, "carpool.plan_restored", planId, { participants: people.size, assignments: assignments.length })];
  const results = await db.batch(statements); if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Carpool plan could not be restored"); return planDetail(db, planId);
}

function median(values: number[]) { const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function locationBias(points: CarpoolGeocodeBias[]): CarpoolGeocodeBias | undefined { return points.length ? { latitude: median(points.map((point) => point.latitude)), longitude: median(points.map((point) => point.longitude)) } : undefined; }

async function resolveLocations(db: D1Database, planId: string, provider: CarpoolGeocodeTransport | undefined, refreshAmbiguous = false, input?: unknown) {
  if (!provider) throw new HttpError(503, "Automatic location lookup is not configured. Enter coordinates manually.");
  const plan = await requirePlan(db, planId); reviewedPlanRevision(input, plan); const rows = (await db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=?").bind(installationId, planId).all<Row>()).results ?? [];
  const updates: ReturnType<D1Database["prepare"]>[] = [];
  const invalidatedPeople = new Map<CarpoolDirection, Set<string>>();
  const referencePoints: CarpoolGeocodeBias[] = [];
  const candidates: Array<{ row: Row; direction: CarpoolDirection; address: string; refresh: boolean }> = [];
  for (const row of rows) for (const selectedDirection of ["outbound", "return"] as const) {
    if (!carpoolDirections((plan.trip_scope ?? "both") as CarpoolTripScope).includes(selectedDirection)) continue;
    if (!["offer", "needs-ride"].includes(String(row[`${selectedDirection}_status`]))) continue;
    if (selectedDirection === "return" && row.return_same_as_outbound === 1 && ["offer", "needs-ride"].includes(String(row.outbound_status))) continue;
    const address = String(row[`${selectedDirection}_address`] ?? "").trim(); if (!address) continue;
    const latitude = row[`${selectedDirection}_lat`]; const longitude = row[`${selectedDirection}_lon`]; const ambiguous = carpoolAddressNeedsLocality(address);
    if (!ambiguous && typeof latitude === "number" && typeof longitude === "number") referencePoints.push({ latitude, longitude });
    const refresh = refreshAmbiguous && ambiguous && latitude !== null;
    if (latitude === null || refresh) candidates.push({ row, direction: selectedDirection, address, refresh });
  }
  const resolveCandidate = async (candidate: (typeof candidates)[number], bias?: CarpoolGeocodeBias) => {
    const { row, direction: selectedDirection, address } = candidate; const resolved = await lookupCarpoolLocation(db, provider, address, bias);
    const affected = row.return_same_as_outbound === 1 ? ["outbound", "return"] as const : [selectedDirection];
    for (const trip of affected) if (row[`${trip}_lat`] !== resolved.latitude || row[`${trip}_lon`] !== resolved.longitude) { const ids = invalidatedPeople.get(trip) ?? new Set<string>(); ids.add(String(row.id)); invalidatedPeople.set(trip, ids); }
    const source: LocationSource = resolved.status === "success" ? "lookup" : "no-match";
    const changed = affected.some(trip => row[`${trip}_lat`] !== resolved.latitude || row[`${trip}_lon`] !== resolved.longitude || row[`${trip}_location_source`] !== source || row[`${trip}_location_label`] !== resolved.label);
    if (changed) {
      const missingOnly = candidate.refresh ? "" : ` AND ${selectedDirection}_lat IS NULL`;
      const fields = affected.map(trip => `${trip}_lat=?,${trip}_lon=?,${trip}_location_source=?,${trip}_location_label=?`).join(",");
      updates.push(db.prepare(`UPDATE carpool_people SET ${fields},revision=revision+1,updated_at=? WHERE installation_id=? AND plan_id=? AND id=?${missingOnly}`).bind(...affected.flatMap(() => [resolved.latitude, resolved.longitude, source, resolved.label]), new Date().toISOString(), installationId, planId, row.id));
    }
    return resolved.latitude === null || resolved.longitude === null ? undefined : { address, latitude: resolved.latitude, longitude: resolved.longitude, label: resolved.label ?? undefined };
  };
  for (const candidate of candidates.filter((item) => !carpoolAddressNeedsLocality(item.address))) { const coordinates = await resolveCandidate(candidate); if (coordinates) referencePoints.push(coordinates); }
  if (!referencePoints.length) for (const row of rows) for (const selectedDirection of ["outbound", "return"] as const) { const latitude = row[`${selectedDirection}_lat`]; const longitude = row[`${selectedDirection}_lon`]; if (typeof latitude === "number" && typeof longitude === "number") referencePoints.push({ latitude, longitude }); }
  const bias = locationBias(referencePoints);
  for (const candidate of candidates.filter((item) => carpoolAddressNeedsLocality(item.address))) await resolveCandidate(candidate, bias);
  const invalidations = [...invalidatedPeople].flatMap(([trip, ids]) => { const values = [...ids]; const placeholders = values.map(() => "?").join(","); return [db.prepare(`DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=? AND (rider_id IN (${placeholders}) OR vehicle_person_id IN (${placeholders}))`).bind(installationId, planId, trip, ...values, ...values), db.prepare(`DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction=? AND rider_id IN (${placeholders})`).bind(installationId, planId, trip, ...values)]; });
  if (updates.length) await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(new Date().toISOString(), installationId, planId, plan.revision)], [...invalidations, ...updates]);
  return planDetail(db, planId);
}

export async function carpoolRoute(db: D1Database, actor: string, request: Request, input?: unknown, geocoder?: CarpoolGeocodeTransport, meetingAccess?: MeetingReferenceAccess): Promise<RouteResult> {
  const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean); const planId = parts[3] ? decodeURIComponent(parts[3]) : undefined;
  if (url.pathname === "/admin/carpool/meeting-links" && request.method === "GET") return { status: 200, body: await readCarpoolMeetingLinks(db, meetingAccess) };
  if (url.pathname === "/admin/carpool/context" && request.method === "GET") {
    const archiveFilter = url.searchParams.get("archive") ?? "active"; if (!["active", "archived", "all"].includes(archiveFilter)) throw new HttpError(400, "Choose active, archived, or all events");
    const [plans, members, profiles, defaults] = await Promise.all([
      db.prepare("SELECT installation_id,id,title,destination,event_reference,event_title_snapshot,event_starts_at_snapshot,radius_miles,preferred_radius_miles,notes,archived,revision,created_by,created_at,updated_at,meeting_id,trip_scope,time_zone,outbound_departure_at,return_departure_at FROM carpool_plans WHERE installation_id=? AND (?='all' OR archived=?) ORDER BY updated_at DESC,id").bind(installationId, archiveFilter, archiveFilter === "archived" ? 1 : 0).all<Row>(),
      listActiveRosterIdentities(db, installationId),
      db.prepare("SELECT header_key,mapping_json FROM carpool_import_profiles WHERE installation_id=? ORDER BY updated_at DESC LIMIT 25").bind(installationId).all<Row>(),
      readCarpoolDefaults(db),
    ]);
    const importProfiles = (profiles.results ?? []).flatMap((row) => {
      try { const mapping = JSON.parse(String(row.mapping_json)); return object(mapping) ? [{ headerKey: String(row.header_key), mapping }] : []; }
      catch { return []; }
    });
    const selected = url.searchParams.get("planId"); const detail = selected ? await planDetail(db, selected) : null;
    const [meetingChoices, relatedMeeting] = await Promise.all([meetingAccess?.list() ?? [], detail?.plan.meetingId && meetingAccess ? meetingAccess.find(String(detail.plan.meetingId)) : null]);
    return { status: 200, body: { plans: (plans.results ?? []).map(row => serializePlan(row, false)), members: members.results ?? [], importProfiles, defaults, geocodingConfigured: Boolean(geocoder), meetingReferencesAvailable: Boolean(meetingAccess), meetingChoices, relatedMeeting, detail } };
  }
  if (url.pathname === "/admin/carpool/plans" && request.method === "POST") return { status: 201, body: await createCarpoolPlan(db, actor, input, meetingAccess) };
  if (url.pathname === "/admin/carpool/restore" && request.method === "POST") return { status: 201, body: await restorePlan(db, actor, input) };
  if (planId && parts.length === 4 && request.method === "DELETE") {
    const plan = await requirePlan(db, planId); reviewedPlanRevision(input, plan);
    const results = await guardedMutationBatch(db, [db.prepare("DELETE FROM carpool_plans WHERE installation_id=? AND id=? AND revision=?").bind(installationId, planId, plan.revision)], [audit(db, actor, "carpool.plan_deleted", planId)]);
    if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Carpool event could not be deleted");
    return { status: 200, body: { deleted: true } };
  }
  if (planId && parts.length === 4 && request.method === "PATCH") {
    const existing = await requirePlan(db, planId); const value = planInput(input, existing); const now = new Date().toISOString();
    const results = await withCarpoolMeetingLink(db, carpoolMeetingId(existing.meeting_id), value.meetingId, meetingAccess, (authorized) => guardedMutationBatch(authorized, [authorized.prepare("UPDATE carpool_plans SET title=?,destination=?,meeting_id=?,event_reference=?,event_title_snapshot=?,event_starts_at_snapshot=?,radius_miles=?,preferred_radius_miles=?,notes=?,archived=?,trip_scope=?,time_zone=?,outbound_departure_at=?,return_departure_at=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(value.title, value.destination, value.meetingId, value.eventReference, value.eventTitleSnapshot, value.eventStartsAtSnapshot, value.radiusMiles, value.preferredRadiusMiles, value.notes, value.archived ? 1 : 0, value.tripScope, value.timeZone, value.outboundDepartureAt, value.returnDepartureAt, now, installationId, planId, value.revision)], [audit(authorized, actor, "carpool.plan_updated", planId)])); if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Carpool plan changed; reload before saving"); return { status: 200, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "people" && parts.length === 5 && request.method === "POST") {
    const plan = await requirePlan(db, planId); reviewedPlanRevision(input, plan); const value = await reconcileParticipantLocations(db, personInput(input), input); if (value.memberId && !await activeRosterIdentity(db, installationId, value.memberId)) throw new HttpError(400, "Choose an active roster member or leave the participant unlinked"); const currentCount = await db.prepare("SELECT COUNT(*) AS count FROM carpool_people WHERE installation_id=? AND plan_id=?").bind(installationId, planId).first<{ count: number }>(); if (Number(currentCount?.count ?? 0) >= 500) throw new HttpError(400, "A Carpool plan may contain at most 500 participants"); const id = crypto.randomUUID(); const now = new Date().toISOString();
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [db.prepare("INSERT INTO carpool_people(installation_id,plan_id,id,member_id,display_name,contact,outbound_status,outbound_address,outbound_lat,outbound_lon,outbound_seats,return_status,return_address,return_lat,return_lon,return_seats,return_same_as_outbound,notes,revision,created_at,updated_at,outbound_location_source,outbound_location_label,return_location_source,return_location_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, id, value.memberId, value.displayName, value.contact, value.outboundStatus, value.outboundAddress, value.outboundLatitude, value.outboundLongitude, value.outboundSeats, value.returnStatus, value.returnAddress, value.returnLatitude, value.returnLongitude, value.returnSeats, value.returnSameAsOutbound ? 1 : 0, value.notes, 0, now, now, value.outboundLocationSource, value.outboundLocationLabel, value.returnLocationSource, value.returnLocationLabel), audit(db, actor, "carpool.participant_added", planId, { participantId: id, rosterLinked: Boolean(value.memberId) })]); return { status: 201, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "people" && parts[5] && request.method === "PATCH") {
    const personId = decodeURIComponent(parts[5]); const value = personInput(input); const [plan, existing] = await Promise.all([requirePlan(db, planId), db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, personId).first<Row>()]); if (!existing) throw new HttpError(404, "Participant not found"); reviewedPlanRevision(input, plan); await reconcileParticipantLocations(db, value, input, existing); if (value.memberId && value.memberId !== existing.member_id && !await activeRosterIdentity(db, installationId, value.memberId)) throw new HttpError(400, "Choose an active roster member or leave the participant unlinked"); const now = new Date().toISOString(); const outboundChanged = ["outbound_status", "outbound_address", "outbound_lat", "outbound_lon", "outbound_seats"].some((key) => existing[key] !== ({ outbound_status: value.outboundStatus, outbound_address: value.outboundAddress, outbound_lat: value.outboundLatitude, outbound_lon: value.outboundLongitude, outbound_seats: value.outboundSeats } as Row)[key]); const returnChanged = ["return_status", "return_address", "return_lat", "return_lon", "return_seats"].some((key) => existing[key] !== ({ return_status: value.returnStatus, return_address: value.returnAddress, return_lat: value.returnLatitude, return_lon: value.returnLongitude, return_seats: value.returnSeats } as Row)[key]); const update = db.prepare("UPDATE carpool_people SET member_id=?,display_name=?,contact=?,outbound_status=?,outbound_address=?,outbound_lat=?,outbound_lon=?,outbound_seats=?,return_status=?,return_address=?,return_lat=?,return_lon=?,return_seats=?,return_same_as_outbound=?,notes=?,outbound_location_source=?,outbound_location_label=?,return_location_source=?,return_location_label=?,revision=revision+1,updated_at=? WHERE installation_id=? AND plan_id=? AND id=? AND revision=?").bind(value.memberId, value.displayName, value.contact, value.outboundStatus, value.outboundAddress, value.outboundLatitude, value.outboundLongitude, value.outboundSeats, value.returnStatus, value.returnAddress, value.returnLatitude, value.returnLongitude, value.returnSeats, value.returnSameAsOutbound ? 1 : 0, value.notes, value.outboundLocationSource, value.outboundLocationLabel, value.returnLocationSource, value.returnLocationLabel, now, installationId, planId, personId, value.revision); const following = [...(outboundChanged ? [db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction='outbound' AND (rider_id=? OR vehicle_person_id=?)").bind(installationId, planId, personId, personId), db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction='outbound' AND rider_id=?").bind(installationId, planId, personId)] : []), ...(returnChanged ? [db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction='return' AND (rider_id=? OR vehicle_person_id=?)").bind(installationId, planId, personId, personId), db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction='return' AND rider_id=?").bind(installationId, planId, personId)] : []), audit(db, actor, "carpool.participant_updated", planId, { participantId: personId, outboundInvalidated: outboundChanged, returnInvalidated: returnChanged })]; const results = await guardedMutationBatch(db, [update, db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], following); if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Participant changed; reload before saving"); return { status: 200, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "people" && parts[5] && request.method === "DELETE") {
    const personId = decodeURIComponent(parts[5]); const plan = await requirePlan(db, planId); reviewedPlanRevision(input, plan);
    const existing = await db.prepare("SELECT id FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, personId).first<{ id: string }>();
    if (!existing) throw new HttpError(404, "Participant not found");
    const settings = parseGroupSettings(plan.group_settings_json).filter(item => item.vehiclePersonId !== personId);
    const results = await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET group_settings_json=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(JSON.stringify(settings), new Date().toISOString(), installationId, planId, plan.revision)], [db.prepare("DELETE FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, personId), audit(db, actor, "carpool.participant_removed", planId, { participantId: personId })]);
    if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Participant could not be removed");
    return { status: 200, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "import" && request.method === "POST") {
    let prepared: Awaited<ReturnType<typeof prepareCarpoolImport>>;
    try { prepared = await prepareCarpoolImport(db, planId, input); } catch (error) { if (error instanceof CarpoolImportError) return { status: 422, body: { error: error.message, details: error.details, issues: error.issues } }; throw error; }
    const { plan, imported, existingRows, changes } = prepared;
    if (parts[5] === "preview") return { status: 200, body: { planRevision: plan.revision, previewToken: prepared.previewToken, summary: prepared.summary, people: changes.map(change => { const effective = change.merge?.merged ?? change.incoming; return { sourceRow: change.person.sourceRow, displayName: effective.display_name, memberLinked: Boolean(effective.member_id), contact: effective.contact, outboundStatus: effective.outbound_status, outboundAddress: effective.outbound_address, outboundSeats: effective.outbound_seats, returnStatus: effective.return_status, returnAddress: effective.return_address, returnSeats: effective.return_seats, disposition: change.existing ? "existing" : "new", staffEditsPreserved: change.staffPreserved }; }) } };
    if (object(input) && input.previewToken !== undefined && input.previewToken !== prepared.previewToken) throw new HttpError(409, "The import preview changed. Review a fresh preview before importing.");
    const now = new Date().toISOString(); const headersKey = imported.headers.join("\u001f"); let added = 0; let merged = 0; const statements = []; const invalidateOutbound = new Set<string>(); const invalidateReturn = new Set<string>();
    for (const { person, existing, incoming, merge: sourceMerge } of changes) {
      if (existing && sourceMerge) {
        merged++; const location = importLocationMetadata(existing, sourceMerge.merged);
        statements.push(db.prepare("UPDATE carpool_people SET member_id=?,display_name=?,contact=?,source_row=?,import_identity=?,import_snapshot_json=?,outbound_status=?,outbound_address=?,outbound_lat=?,outbound_lon=?,outbound_seats=?,return_status=?,return_address=?,return_lat=?,return_lon=?,return_seats=?,return_same_as_outbound=?,notes=?,outbound_location_source=?,outbound_location_label=?,return_location_source=?,return_location_label=?,revision=revision+1,updated_at=? WHERE installation_id=? AND plan_id=? AND id=?").bind(sourceMerge.merged.member_id, sourceMerge.merged.display_name, sourceMerge.merged.contact, person.sourceRow, existing.import_identity ?? person.importIdentity, JSON.stringify(incoming), sourceMerge.merged.outbound_status, sourceMerge.merged.outbound_address, sourceMerge.merged.outbound_lat, sourceMerge.merged.outbound_lon, sourceMerge.merged.outbound_seats, sourceMerge.merged.return_status, sourceMerge.merged.return_address, sourceMerge.merged.return_lat, sourceMerge.merged.return_lon, sourceMerge.merged.return_seats, sourceMerge.merged.return_same_as_outbound, sourceMerge.merged.notes, location.outbound_location_source, location.outbound_location_label, location.return_location_source, location.return_location_label, now, installationId, planId, existing.id));
        if (sourceMerge.outboundUpdated) invalidateOutbound.add(String(existing.id)); if (sourceMerge.returnUpdated) invalidateReturn.add(String(existing.id));
      } else {
        added++; const location = importLocationMetadata(undefined, incoming); statements.push(db.prepare("INSERT INTO carpool_people(installation_id,plan_id,id,member_id,display_name,contact,source_row,import_identity,import_snapshot_json,outbound_status,outbound_address,outbound_lat,outbound_lon,outbound_seats,return_status,return_address,return_lat,return_lon,return_seats,return_same_as_outbound,notes,revision,created_at,updated_at,outbound_location_source,outbound_location_label,return_location_source,return_location_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, crypto.randomUUID(), incoming.member_id, person.displayName, person.contact, person.sourceRow, person.importIdentity, JSON.stringify(incoming), person.outboundStatus, person.outboundAddress, person.outboundLatitude, person.outboundLongitude, person.outboundSeats, person.returnStatus, person.returnAddress, person.returnLatitude, person.returnLongitude, person.returnSeats, person.returnSameAsOutbound ? 1 : 0, person.notes, 0, now, now, location.outbound_location_source, location.outbound_location_label, location.return_location_source, location.return_location_label));
      }
    }
    if (existingRows.length + added > 500) throw new HttpError(400, "A Carpool plan may contain at most 500 participants");
    for (const [selectedDirection, ids] of [["outbound", invalidateOutbound], ["return", invalidateReturn]] as const) if (ids.size) { const values = [...ids]; const placeholders = values.map(() => "?").join(","); statements.push(db.prepare(`DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=? AND (rider_id IN (${placeholders}) OR vehicle_person_id IN (${placeholders}))`).bind(installationId, planId, selectedDirection, ...values, ...values), db.prepare(`DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction=? AND rider_id IN (${placeholders})`).bind(installationId, planId, selectedDirection, ...values)); }
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [...statements, db.prepare("INSERT INTO carpool_import_profiles(installation_id,header_key,mapping_json,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(installation_id,header_key) DO UPDATE SET mapping_json=excluded.mapping_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(installationId, headersKey, JSON.stringify(prepared.mapping), actor, now), audit(db, actor, "carpool.csv_imported", planId, { rows: imported.people.length, added, merged })]); return { status: 201, body: { imported: imported.people.length, added, merged, detail: await planDetail(db, planId) } };
  }
  if (planId && parts[4] === "rebuild" && request.method === "POST" && !parts[6]) {
    if (parts[5] === "undo") return { status: 200, body: await undoRebuild(db, actor, planId, input) };
    if (!["preview", "apply"].includes(parts[5] ?? "") || !object(input)) throw new HttpError(404, "Carpool rebuild route not found");
    const selectedDirection = input.direction === "both" ? "both" : direction(input.direction); const prepared = await prepareRebuild(db, planId, selectedDirection, input, true);
    if (parts[5] === "preview") return { status: 200, body: { planRevision: prepared.expected, previewToken: prepared.previewToken, directions: prepared.directions, radiusMiles: prepared.settings.radiusMiles, preferredRadiusMiles: prepared.settings.preferredRadiusMiles, ...prepared.proposal } };
    if (input.previewToken !== prepared.previewToken) throw new HttpError(409, "The rebuild preview changed. Review a fresh preview before applying groups.");
    return { status: 200, body: await applyRebuild(db, actor, planId, prepared) };
  }
  if (planId && parts[4] === "groups" && parts[5] && parts[6] && !parts[7] && request.method === "PATCH") {
    if (!object(input) || input.planRevision === undefined || Object.keys(input).some(key => !["label", "color", "planRevision"].includes(key))) throw new HttpError(400, "Provide reviewed group settings");
    const plan = await requirePlan(db, planId); reviewedPlanRevision(input, plan); const trip = direction(parts[5]); const vehiclePersonId = decodeURIComponent(parts[6]);
    if (!carpoolDirections((plan.trip_scope ?? "both") as CarpoolTripScope).includes(trip)) throw new HttpError(400, "That trip direction is not planned for this event");
    const vehicle = await db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, vehiclePersonId).first<Row>(); if (!vehicle || vehicle[trip + "_status"] !== "offer") throw new HttpError(400, "Choose an eligible driver for this group");
    const current = parseGroupSettings(plan.group_settings_json).filter(item => !(item.direction === trip && item.vehiclePersonId === vehiclePersonId)); const settings = validateGroupSettings([...current, { direction: trip, vehiclePersonId, label: text(input.label, "a group label", 80), color: input.color }]);
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET group_settings_json=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(JSON.stringify(settings), new Date().toISOString(), installationId, planId, plan.revision)], [audit(db, actor, "carpool.group_updated", planId, { direction: trip, vehiclePersonId })]);
    return { status: 200, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "generate" && parts[5] && request.method === "POST") return { status: 200, body: await generate(db, actor, planId, parts[5] === "both" ? "both" : direction(parts[5]), input) };
  if (planId && parts[4] === "assignments" && parts[5] && parts[6] && request.method === "PATCH") return { status: 200, body: await assignmentAction(db, actor, planId, direction(parts[5]), decodeURIComponent(parts[6]), input) };
  if (planId && parts[4] === "share" && !parts[5] && request.method === "GET") {
    if (!/^(0|[1-9]\d*)$/.test(url.searchParams.get("planRevision") ?? "")) throw new HttpError(400, "Provide the reviewed plan version");
    const expected = revision(Number(url.searchParams.get("planRevision"))); const detail = await planDetail(db, planId);
    if (detail.plan.revision !== expected) throw new HttpError(409, "The plan changed. Refresh the saved plan before sharing.");
    let preview: ReturnType<typeof buildCarpoolShare>; try { preview = buildCarpoolShare(detail as unknown as CarpoolShareInput, { direction: direction(url.searchParams.get("direction")), driverId: url.searchParams.get("driverId") || undefined, unsaved: url.searchParams.get("unsaved") === "1" }, new Date().toISOString()); } catch (error) { throw new HttpError(400, (error as Error).message); }
    if ((await requirePlan(db, planId)).revision !== expected) throw new HttpError(409, "The plan changed while this preview was prepared. Refresh before sharing.");
    const filename = String(detail.plan.title).replace(/[^a-z0-9]+/gi, "-").toLocaleLowerCase() + "-" + preview.direction + "-" + preview.audience + "-v" + preview.version + ".csv";
    return { status: 200, body: { preview, filename, content: carpoolCsv(carpoolShareRows(preview)) } };
  }
  if (planId && parts[4] === "export" && request.method === "GET") return { status: 200, body: await exportPlan(db, planId, url.searchParams.get("kind") ?? "outbound") };
  if (planId && parts[4] === "locations" && parts[5] === "lookup" && request.method === "POST") {
    const plan = await requirePlan(db, planId); reviewedPlanRevision(input, plan);
    if (!object(input)) throw new HttpError(400, "Provide an address to locate");
    const address = text(input.address, "an address", 500, true); const trip = direction(input.direction);
    if (!carpoolDirections((plan.trip_scope ?? "both") as CarpoolTripScope).includes(trip)) throw new HttpError(400, "That trip direction is not planned for this event");
    if (!geocoder) throw new HttpError(503, "Automatic location lookup is not configured. Place a pin or enter manual coordinates.");
    const rows = (await db.prepare("SELECT outbound_address,outbound_lat,outbound_lon,return_address,return_lat,return_lon FROM carpool_people WHERE installation_id=? AND plan_id=?").bind(installationId, planId).all<Row>()).results ?? [];
    const points = rows.flatMap(row => carpoolDirections((plan.trip_scope ?? "both") as CarpoolTripScope).flatMap(trip => typeof row[`${trip}_lat`] === "number" && typeof row[`${trip}_lon`] === "number" && !carpoolAddressNeedsLocality(String(row[`${trip}_address`])) ? [{ latitude: row[`${trip}_lat`] as number, longitude: row[`${trip}_lon`] as number }] : []));
    const located = await lookupCarpoolLocation(db, geocoder, address, carpoolAddressNeedsLocality(address) ? locationBias(points) : undefined);
    return { status: 200, body: located };
  }
  if (planId && parts[4] === "locations" && parts[5] === "resolve" && request.method === "POST") return { status: 200, body: await resolveLocations(db, planId, geocoder, object(input) && input.refreshAmbiguous === true, input) };
  throw new HttpError(404, "Carpool route not found");
}
