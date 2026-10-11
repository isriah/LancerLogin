import { HttpError } from "./http-error.ts";
import type { D1Database } from "./d1-usage.ts";
import { carpoolCsv, mapCarpoolCsv, type CarpoolColumnMapping } from "./carpool-csv.ts";
import { carpoolAddressNeedsLocality, carpoolLocationCacheKey, normalizeCarpoolAddress, type CarpoolGeocodeBias, type CarpoolGeocodeTransport } from "./carpool-geocoding.ts";
import { legFor, moveCarpoolAssignment, suggestCarpoolPlan, swapCarpoolAssignments, type CarpoolAssignment, type CarpoolDirection, type CarpoolPerson, type CarpoolStatus } from "./carpool-planning.ts";
import { activeRosterIdentity, listActiveRosterIdentities } from "./core-roster-projection.ts";
import type { MeetingReferenceAccess } from "./attendance-meeting-reference.ts";
import { carpoolMeetingId, readCarpoolMeetingLinks, withCarpoolMeetingLink } from "./carpool-meeting-links.ts";

type Row = Record<string, unknown>;
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
const audit = (db: D1Database, actor: string, action: string, target: string, metadata: object = {}) => db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), installationId, actor, action, "carpool_plan", target, JSON.stringify(metadata), new Date().toISOString());
async function guardedMutationBatch(db: D1Database, guards: ReturnType<D1Database["prepare"]>[], following: ReturnType<D1Database["prepare"]>[]) {
  const statements = guards.flatMap((guard) => [guard, db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','carpool-revision-conflict') END AS updated")]);
  try { return await db.batch([...statements, ...following]); }
  catch (error) { if (error instanceof Error && error.message.includes("carpool-revision-conflict")) throw new HttpError(409, "Record changed; reload before saving"); throw error; }
}

function serializePlan(row: Row) { return { id: row.id, title: row.title, destination: row.destination, meetingId: row.meeting_id ?? null, eventReference: row.event_reference, eventTitleSnapshot: row.event_title_snapshot, eventStartsAtSnapshot: row.event_starts_at_snapshot, radiusMiles: row.radius_miles, preferredRadiusMiles: row.preferred_radius_miles, notes: row.notes, archived: Boolean(row.archived), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }; }
function serializePerson(row: Row) { const snapshot = parsedImportSnapshot(row.import_snapshot_json); return { id: row.id, planId: row.plan_id, memberId: row.member_id, memberExternalId: row.member_external_id ?? null, memberActive: row.member_active === null || row.member_active === undefined ? null : Boolean(row.member_active), displayName: row.display_name, contact: row.contact, sourceRow: row.source_row, importIdentity: row.import_identity, importSourceMemberExternalId: row.import_source_member_external_id ?? null, importSnapshot: snapshot, outboundSourceStatus: snapshot?.outbound_source_status ?? null, outboundStatus: row.outbound_status, outboundAddress: row.outbound_address, outboundLatitude: row.outbound_lat, outboundLongitude: row.outbound_lon, outboundSeats: row.outbound_seats, returnSourceStatus: snapshot?.return_source_status ?? null, returnStatus: row.return_status, returnAddress: row.return_address, returnLatitude: row.return_lat, returnLongitude: row.return_lon, returnSeats: row.return_seats, returnSameAsOutbound: Boolean(row.return_same_as_outbound), notes: row.notes, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at }; }
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
function mergeImportSnapshot(row: Row, incoming: ImportSnapshot) {
  const previous = parsedImportSnapshot(row.import_snapshot_json);
  const merged = { ...incoming };
  const mergedKeys = ["member_id", "display_name", "contact", "outbound_status", "outbound_address", "outbound_lat", "outbound_lon", "outbound_seats", "return_status", "return_address", "return_lat", "return_lon", "return_seats", "return_same_as_outbound", "notes"] as const;
  for (const key of mergedKeys) {
    if (!previous || row[key] !== previous[key]) (merged as Record<string, unknown>)[key] = row[key];
  }
  const outboundUpdated = (["outbound_status", "outbound_address", "outbound_lat", "outbound_lon", "outbound_seats"] as const).some((key) => merged[key] !== row[key]);
  const returnUpdated = (["return_status", "return_address", "return_lat", "return_lon", "return_seats", "return_same_as_outbound"] as const).some((key) => merged[key] !== row[key]);
  return { merged, outboundUpdated, returnUpdated };
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
  if (!object(value) || Object.keys(value).some((key) => !["title", "destination", "meetingId", "eventReference", "eventTitleSnapshot", "eventStartsAtSnapshot", "radiusMiles", "preferredRadiusMiles", "notes", "archived", "revision"].includes(key))) throw new HttpError(400, "Provide a Carpool plan");
  const radiusMiles = value.radiusMiles === undefined ? Number(existing?.radius_miles ?? 12) : number(value.radiusMiles, "a planning radius", 0.5, 250);
  const preferredRadiusMiles = value.preferredRadiusMiles === undefined ? Number(existing?.preferred_radius_miles ?? Math.min(4, radiusMiles)) : number(value.preferredRadiusMiles, "a preferred radius", 0.5, radiusMiles);
  const eventStartsAtSnapshot = nullableText(value.eventStartsAtSnapshot ?? existing?.event_starts_at_snapshot, "a valid event start snapshot", 50);
  if (eventStartsAtSnapshot && !Number.isFinite(Date.parse(eventStartsAtSnapshot))) throw new HttpError(400, "Provide a valid event start snapshot");
  if (value.archived !== undefined && typeof value.archived !== "boolean") throw new HttpError(400, "Archived must be true or false");
  return { title: text(value.title ?? existing?.title, "a plan title", 150, true), destination: text(value.destination ?? existing?.destination ?? "", "a destination", 300), meetingId: carpoolMeetingId(value.meetingId === undefined ? existing?.meeting_id : value.meetingId), eventReference: nullableText(value.eventReference ?? existing?.event_reference, "an event reference", 200), eventTitleSnapshot: nullableText(value.eventTitleSnapshot ?? existing?.event_title_snapshot, "an event title snapshot", 150), eventStartsAtSnapshot, radiusMiles, preferredRadiusMiles, notes: text(value.notes ?? existing?.notes ?? "", "plan notes", 4000), archived: value.archived === undefined ? Boolean(existing?.archived) : value.archived, revision: value.revision === undefined ? undefined : revision(value.revision) };
}

function personInput(value: unknown) {
  const allowed = ["memberId", "displayName", "contact", "outboundStatus", "outboundAddress", "outboundLatitude", "outboundLongitude", "outboundSeats", "returnStatus", "returnAddress", "returnLatitude", "returnLongitude", "returnSeats", "returnSameAsOutbound", "notes", "revision"];
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new HttpError(400, "Provide a Carpool participant");
  const outboundStatus = status(value.outboundStatus, "an outbound ride status"); const returnStatus = status(value.returnStatus, "a return ride status");
  const outboundLatitude = nullableCoordinate(value.outboundLatitude, "outbound latitude", -90, 90); const outboundLongitude = nullableCoordinate(value.outboundLongitude, "outbound longitude", -180, 180);
  const returnLatitude = nullableCoordinate(value.returnLatitude, "return latitude", -90, 90); const returnLongitude = nullableCoordinate(value.returnLongitude, "return longitude", -180, 180);
  if ((outboundLatitude === null) !== (outboundLongitude === null) || (returnLatitude === null) !== (returnLongitude === null)) throw new HttpError(400, "Latitude and longitude must be entered together");
  const outboundSeats = outboundStatus === "offer" ? number(value.outboundSeats, "outbound seats", 0, 99) : null;
  const returnSeats = returnStatus === "offer" ? number(value.returnSeats, "return seats", 0, 99) : null;
  if (!Number.isInteger(outboundSeats) && outboundSeats !== null || !Number.isInteger(returnSeats) && returnSeats !== null) throw new HttpError(400, "Seat counts must be whole numbers");
  if (typeof value.returnSameAsOutbound !== "boolean") throw new HttpError(400, "Choose whether return uses the outbound location");
  return { memberId: nullableText(value.memberId, "a roster member", 128), displayName: text(value.displayName, "a participant name", 150, true), contact: text(value.contact ?? "", "contact information", 300), outboundStatus, outboundAddress: text(value.outboundAddress ?? "", "an outbound address", 500), outboundLatitude, outboundLongitude, outboundSeats, returnStatus, returnAddress: text(value.returnAddress ?? "", "a return address", 500), returnLatitude, returnLongitude, returnSeats, returnSameAsOutbound: value.returnSameAsOutbound, notes: text(value.notes ?? "", "participant notes", 4000), revision: value.revision === undefined ? undefined : revision(value.revision) };
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
  return { plan: serializePlan(plan), people: (people.results ?? []).map(serializePerson), assignments: (assignments.results ?? []).map(serializeAssignment), unresolved: (unresolved.results ?? []).map(serializeUnresolved) };
}

export async function createCarpoolPlan(db: D1Database, actor: string, value: unknown, meetingAccess?: MeetingReferenceAccess) {
  const input = planInput(value); const id = crypto.randomUUID(); const now = new Date().toISOString();
  const results = await withCarpoolMeetingLink(db, null, input.meetingId, meetingAccess, (authorized) => authorized.batch([
    authorized.prepare("INSERT INTO carpool_plans(installation_id,id,title,destination,event_reference,event_title_snapshot,event_starts_at_snapshot,radius_miles,preferred_radius_miles,notes,archived,revision,created_by,created_at,updated_at,meeting_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, id, input.title, input.destination, input.eventReference, input.eventTitleSnapshot, input.eventStartsAtSnapshot, input.radiusMiles, input.preferredRadiusMiles, input.notes, input.archived ? 1 : 0, 0, actor, now, now, input.meetingId),
    audit(authorized, actor, "carpool.plan_created", id),
  ]));
  if (results.some((result) => result.meta?.changes !== 1)) throw new HttpError(409, "Carpool plan could not be created");
  return planDetail(db, id);
}

function toPlanningPerson(row: Row): CarpoolPerson { return { id: String(row.id), displayName: String(row.display_name), outbound: { status: row.outbound_status as CarpoolStatus, address: String(row.outbound_address), latitude: row.outbound_lat === null ? null : Number(row.outbound_lat), longitude: row.outbound_lon === null ? null : Number(row.outbound_lon), seats: row.outbound_seats === null ? null : Number(row.outbound_seats) }, return: { status: row.return_status as CarpoolStatus, address: String(row.return_address), latitude: row.return_lat === null ? null : Number(row.return_lat), longitude: row.return_lon === null ? null : Number(row.return_lon), seats: row.return_seats === null ? null : Number(row.return_seats) } }; }
function toPlanningAssignment(row: Row): CarpoolAssignment { return { riderId: String(row.rider_id), vehiclePersonId: String(row.vehicle_person_id), distanceMiles: Number(row.distance_miles), locked: Boolean(row.locked), manual: Boolean(row.manual) }; }

async function generate(db: D1Database, actor: string, planId: string, requestedDirection: CarpoolDirection | "both") {
  const plan = await requirePlan(db, planId);
  const peopleRows = (await db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? ORDER BY id").bind(installationId, planId).all<Row>()).results ?? [];
  const assignmentRows = (await db.prepare("SELECT * FROM carpool_assignments WHERE installation_id=? AND plan_id=?").bind(installationId, planId).all<Row>()).results ?? [];
  const people = peopleRows.map(toPlanningPerson); const directions: CarpoolDirection[] = requestedDirection === "both" ? ["outbound", "return"] : [requestedDirection];
  const suggestions = new Map<CarpoolDirection, ReturnType<typeof suggestCarpoolPlan>>();
  for (const selectedDirection of directions) {
    const otherDirection: CarpoolDirection = selectedDirection === "outbound" ? "return" : "outbound";
    const existing = assignmentRows.filter((row) => row.direction === selectedDirection).map(toPlanningAssignment);
    const other = suggestions.get(otherDirection)?.assignments ?? assignmentRows.filter((row) => row.direction === otherDirection).map(toPlanningAssignment);
    const suggestion = suggestCarpoolPlan({ people, direction: selectedDirection, radiusMiles: Number(plan.radius_miles), preferredRadiusMiles: Number(plan.preferred_radius_miles), existing, otherDirection: other });
    if (suggestion.conflicts.length) throw new HttpError(409, "Resolve locked assignments before regenerating", suggestion.conflicts);
    suggestions.set(selectedDirection, suggestion);
  }
  const now = new Date().toISOString();
  const writes = [...suggestions].flatMap(([selectedDirection, suggestion]) => [
    db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection),
    db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection),
    ...suggestion.assignments.map((assignment) => db.prepare("INSERT INTO carpool_assignments(installation_id,plan_id,direction,rider_id,vehicle_person_id,distance_miles,locked,manual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, selectedDirection, assignment.riderId, assignment.vehiclePersonId, assignment.distanceMiles, assignment.locked ? 1 : 0, assignment.manual ? 1 : 0, now, now)),
    ...suggestion.unresolved.map((item) => db.prepare("INSERT INTO carpool_unresolved(installation_id,plan_id,direction,rider_id,reason,detail,created_at) VALUES(?,?,?,?,?,?,?)").bind(installationId, planId, selectedDirection, item.riderId, item.reason, item.detail, now)),
  ]);
  const totals = [...suggestions.values()].reduce((result, suggestion) => ({ assignments: result.assignments + suggestion.assignments.length, unresolved: result.unresolved + suggestion.unresolved.length }), { assignments: 0, unresolved: 0 });
  const results = await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [
    ...writes,
    audit(db, actor, "carpool.plan_generated", planId, { direction: requestedDirection, ...totals }),
  ]);
  if (results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Carpool suggestions could not be saved");
  return planDetail(db, planId);
}

async function assignmentAction(db: D1Database, actor: string, planId: string, selectedDirection: CarpoolDirection, riderId: string, value: unknown) {
  if (!object(value) || !["lock", "move", "swap"].includes(String(value.action))) throw new HttpError(400, "Choose an assignment action");
  const plan = await requirePlan(db, planId); const now = new Date().toISOString();
  if (value.action === "lock") {
    if (typeof value.locked !== "boolean") throw new HttpError(400, "Choose locked or unlocked");
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision), db.prepare("UPDATE carpool_assignments SET locked=?,updated_at=? WHERE installation_id=? AND plan_id=? AND direction=? AND rider_id=?").bind(value.locked ? 1 : 0, now, installationId, planId, selectedDirection, riderId)], [audit(db, actor, "carpool.assignment_lock", planId, { direction: selectedDirection, riderId })]);
    return planDetail(db, planId);
  } else {
    const peopleRows = (await db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? ORDER BY id").bind(installationId, planId).all<Row>()).results ?? [];
    const rows = (await db.prepare("SELECT * FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection).all<Row>()).results ?? [];
    const current = rows.map(toPlanningAssignment); let next: CarpoolAssignment[] | undefined; let error: string | undefined;
    if (value.action === "move") ({ assignments: next, error } = moveCarpoolAssignment({ people: peopleRows.map(toPlanningPerson), direction: selectedDirection, assignments: current, riderId, vehiclePersonId: text(value.vehiclePersonId, "a car", 128, true) }));
      else ({ assignments: next, error } = swapCarpoolAssignments({ people: peopleRows.map(toPlanningPerson), direction: selectedDirection, assignments: current, firstRiderId: riderId, secondRiderId: text(value.secondRiderId, "another assigned rider", 128, true) }));
    if (error || !next) throw new HttpError(409, error ?? "Assignment could not be changed");
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection), ...next.map((item) => db.prepare("INSERT INTO carpool_assignments(installation_id,plan_id,direction,rider_id,vehicle_person_id,distance_miles,locked,manual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, selectedDirection, item.riderId, item.vehiclePersonId, item.distanceMiles, item.locked ? 1 : 0, item.manual ? 1 : 0, now, now)), audit(db, actor, `carpool.assignment_${String(value.action)}`, planId, { direction: selectedDirection, riderId })]);
    return planDetail(db, planId);
  }
}

async function exportPlan(db: D1Database, planId: string, kind: string) {
  const detail = await planDetail(db, planId); const people = new Map(detail.people.map((person) => [String(person.id), person]));
  if (kind === "backup") return { format: "lancerlogin-carpool-plan", schemaVersion: 1, exportedAt: new Date().toISOString(), ...detail, plan: { ...detail.plan, meetingId: null }, people: detail.people.map((person) => ({ ...person, memberId: null, importSnapshot: person.importSnapshot ? { ...person.importSnapshot, member_id: null } : null })) };
  if (kind === "unresolved") return { filename: `${String(detail.plan.title).replace(/[^a-z0-9]+/gi, "-").toLocaleLowerCase()}-unassigned.csv`, content: carpoolCsv(detail.unresolved.map((item) => { const person = people.get(String(item.riderId))!; return { Direction: item.direction === "outbound" ? "To event" : "From event", Name: person?.displayName ?? item.riderId, Contact: person?.contact ?? "", Reason: item.reason, Detail: item.detail }; })) };
  const selectedDirection = direction(kind); const assignments = detail.assignments.filter((item) => item.direction === selectedDirection);
  return { filename: `${String(detail.plan.title).replace(/[^a-z0-9]+/gi, "-").toLocaleLowerCase()}-${selectedDirection}.csv`, content: carpoolCsv(assignments.map((item) => { const rider = people.get(String(item.riderId))!; const vehicle = people.get(String(item.vehiclePersonId))!; return { Direction: selectedDirection === "outbound" ? "To event" : "From event", Driver: vehicle?.displayName ?? item.vehiclePersonId, "Driver contact": vehicle?.contact ?? "", Rider: rider?.displayName ?? item.riderId, "Rider contact": rider?.contact ?? "", "Straight-line distance (miles)": Number(item.distanceMiles).toFixed(2), Locked: item.locked ? "Yes" : "No" }; })) };
}

async function restorePlan(db: D1Database, actor: string, value: unknown) {
  if (!object(value) || value.format !== "lancerlogin-carpool-plan" || value.schemaVersion !== 1 || !object(value.plan) || !Array.isArray(value.people) || !Array.isArray(value.assignments) || !Array.isArray(value.unresolved)) throw new HttpError(400, "This is not a supported Carpool plan backup");
  if (value.people.length > 500 || value.assignments.length > 1_000 || value.unresolved.length > 1_000) throw new HttpError(400, "Carpool backup is too large for plan restore");
  const sourcePlan = value.plan; const restoredPlan = planInput({ title: sourcePlan.title, destination: sourcePlan.destination, eventReference: sourcePlan.eventReference, eventTitleSnapshot: sourcePlan.eventTitleSnapshot, eventStartsAtSnapshot: sourcePlan.eventStartsAtSnapshot, radiusMiles: sourcePlan.radiusMiles, preferredRadiusMiles: sourcePlan.preferredRadiusMiles, notes: sourcePlan.notes, archived: false });
  const roster = await listActiveRosterIdentities(db, installationId); const activeRosterByExternalId = new Map((roster.results ?? []).map((member) => [member.externalId.toLocaleLowerCase(), member.id]));
  const planId = crypto.randomUUID(); const now = new Date().toISOString(); const people = new Map<string, { id: string; value: ReturnType<typeof personInput>; sourceRow: number | null; importIdentity: string | null; importSnapshotJson: string | null }>(); const importIdentities = new Set<string>();
  for (const item of value.people) {
    if (!object(item) || typeof item.id !== "string" || !item.id || people.has(item.id)) throw new HttpError(400, "Carpool backup contains an invalid participant");
    const currentMemberId = typeof item.memberExternalId === "string" ? activeRosterByExternalId.get(item.memberExternalId.toLocaleLowerCase()) ?? null : null; const sourceMemberId = typeof item.importSourceMemberExternalId === "string" ? activeRosterByExternalId.get(item.importSourceMemberExternalId.toLocaleLowerCase()) ?? null : null;
    const person = personInput({ memberId: currentMemberId, displayName: item.displayName, contact: item.contact, outboundStatus: item.outboundStatus, outboundAddress: item.outboundAddress, outboundLatitude: item.outboundLatitude, outboundLongitude: item.outboundLongitude, outboundSeats: item.outboundSeats, returnStatus: item.returnStatus, returnAddress: item.returnAddress, returnLatitude: item.returnLatitude, returnLongitude: item.returnLongitude, returnSeats: item.returnSeats, returnSameAsOutbound: item.returnSameAsOutbound, notes: item.notes });
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
  const statements = [db.prepare("INSERT INTO carpool_plans(installation_id,id,title,destination,event_reference,event_title_snapshot,event_starts_at_snapshot,radius_miles,preferred_radius_miles,notes,archived,revision,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, restoredPlan.title, restoredPlan.destination, restoredPlan.eventReference, restoredPlan.eventTitleSnapshot, restoredPlan.eventStartsAtSnapshot, restoredPlan.radiusMiles, restoredPlan.preferredRadiusMiles, restoredPlan.notes, 0, 0, actor, now, now), ...[...people.values()].map(({ id, value: person, sourceRow, importIdentity, importSnapshotJson }) => db.prepare("INSERT INTO carpool_people(installation_id,plan_id,id,member_id,display_name,contact,source_row,import_identity,import_snapshot_json,outbound_status,outbound_address,outbound_lat,outbound_lon,outbound_seats,return_status,return_address,return_lat,return_lon,return_seats,return_same_as_outbound,notes,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, id, person.memberId, person.displayName, person.contact, sourceRow, importIdentity, importSnapshotJson, person.outboundStatus, person.outboundAddress, person.outboundLatitude, person.outboundLongitude, person.outboundSeats, person.returnStatus, person.returnAddress, person.returnLatitude, person.returnLongitude, person.returnSeats, person.returnSameAsOutbound ? 1 : 0, person.notes, 0, now, now)), ...assignments.map((item) => db.prepare("INSERT INTO carpool_assignments(installation_id,plan_id,direction,rider_id,vehicle_person_id,distance_miles,locked,manual,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, item.direction, item.riderId, item.vehiclePersonId, item.distanceMiles, item.locked ? 1 : 0, item.manual ? 1 : 0, now, now)), ...unresolved.map((item) => db.prepare("INSERT INTO carpool_unresolved(installation_id,plan_id,direction,rider_id,reason,detail,created_at) VALUES(?,?,?,?,?,?,?)").bind(installationId, planId, item.direction, item.riderId, item.reason, item.detail, now)), audit(db, actor, "carpool.plan_restored", planId, { participants: people.size, assignments: assignments.length })];
  const results = await db.batch(statements); if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Carpool plan could not be restored"); return planDetail(db, planId);
}

function median(values: number[]) { const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function locationBias(points: CarpoolGeocodeBias[]): CarpoolGeocodeBias | undefined { return points.length ? { latitude: median(points.map((point) => point.latitude)), longitude: median(points.map((point) => point.longitude)) } : undefined; }

async function resolveLocations(db: D1Database, planId: string, provider: CarpoolGeocodeTransport | undefined, refreshAmbiguous = false) {
  if (!provider) throw new HttpError(503, "Automatic location lookup is not configured. Enter coordinates manually.");
  const plan = await requirePlan(db, planId); const rows = (await db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=?").bind(installationId, planId).all<Row>()).results ?? [];
  const locations = new Map<string, { address: string; latitude: number; longitude: number; label?: string }>();
  const updates: ReturnType<D1Database["prepare"]>[] = [];
  const invalidatedDirections = new Set<CarpoolDirection>();
  const referencePoints: CarpoolGeocodeBias[] = [];
  const candidates: Array<{ row: Row; direction: CarpoolDirection; address: string; refresh: boolean }> = [];
  for (const row of rows) for (const selectedDirection of ["outbound", "return"] as const) {
    const address = String(row[`${selectedDirection}_address`] ?? "").trim(); if (!address) continue;
    const latitude = row[`${selectedDirection}_lat`]; const longitude = row[`${selectedDirection}_lon`]; const ambiguous = carpoolAddressNeedsLocality(address);
    if (!ambiguous && typeof latitude === "number" && typeof longitude === "number") referencePoints.push({ latitude, longitude });
    const refresh = refreshAmbiguous && ambiguous && latitude !== null;
    if (latitude === null || refresh) candidates.push({ row, direction: selectedDirection, address, refresh });
  }
  const resolveCandidate = async (candidate: (typeof candidates)[number], bias?: CarpoolGeocodeBias) => {
    const { row, direction: selectedDirection, address } = candidate;
    const key = carpoolLocationCacheKey(provider.id, address, bias); let coordinates = locations.get(key);
    if (!coordinates) {
      const cached = await db.prepare("SELECT status,latitude,longitude,label FROM carpool_location_cache WHERE installation_id=? AND cache_key=? AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))").bind(installationId, key).first<{ status: "success" | "no-match"; latitude: number | null; longitude: number | null; label?: string }>();
      if (cached?.status === "no-match") return undefined;
      coordinates = cached?.latitude === null || cached?.longitude === null || !cached ? undefined : { address, latitude: cached.latitude, longitude: cached.longitude, label: cached.label };
    }
    if (!coordinates) { let found; try { found = await provider.resolve(address, bias); } catch (error) { throw new HttpError(502, error instanceof Error ? error.message : "The location provider request failed. Try again."); } if (!found) { const now = new Date(); await db.prepare("INSERT INTO carpool_location_cache(installation_id,cache_key,provider,normalized_address,original_address,status,latitude,longitude,label,saved_at,expires_at) VALUES(?,?,?,?,?,'no-match',NULL,NULL,NULL,?,?) ON CONFLICT(installation_id,cache_key) DO UPDATE SET status='no-match',latitude=NULL,longitude=NULL,label=NULL,saved_at=excluded.saved_at,expires_at=excluded.expires_at").bind(installationId, key, provider.id, normalizeCarpoolAddress(address), address, now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString()).run(); return undefined; } coordinates = { address, ...found }; locations.set(key, coordinates); await db.prepare("INSERT INTO carpool_location_cache(installation_id,cache_key,provider,normalized_address,original_address,status,latitude,longitude,label,saved_at) VALUES(?,?,?,?,?,'success',?,?,?,?) ON CONFLICT(installation_id,cache_key) DO UPDATE SET status='success',latitude=excluded.latitude,longitude=excluded.longitude,label=excluded.label,saved_at=excluded.saved_at,expires_at=NULL").bind(installationId, key, provider.id, normalizeCarpoolAddress(address), address, found.latitude, found.longitude, found.label ?? null, new Date().toISOString()).run(); }
    if (row[`${selectedDirection}_lat`] !== coordinates.latitude || row[`${selectedDirection}_lon`] !== coordinates.longitude) invalidatedDirections.add(selectedDirection);
    const missingOnly = candidate.refresh ? "" : ` AND ${selectedDirection}_lat IS NULL`;
    updates.push(db.prepare(`UPDATE carpool_people SET ${selectedDirection}_lat=?,${selectedDirection}_lon=?,revision=revision+1,updated_at=? WHERE installation_id=? AND plan_id=? AND id=?${missingOnly}`).bind(coordinates.latitude, coordinates.longitude, new Date().toISOString(), installationId, planId, row.id));
    return coordinates;
  };
  for (const candidate of candidates.filter((item) => !carpoolAddressNeedsLocality(item.address))) { const coordinates = await resolveCandidate(candidate); if (coordinates) referencePoints.push(coordinates); }
  if (!referencePoints.length) for (const row of rows) for (const selectedDirection of ["outbound", "return"] as const) { const latitude = row[`${selectedDirection}_lat`]; const longitude = row[`${selectedDirection}_lon`]; if (typeof latitude === "number" && typeof longitude === "number") referencePoints.push({ latitude, longitude }); }
  const bias = locationBias(referencePoints);
  for (const candidate of candidates.filter((item) => carpoolAddressNeedsLocality(item.address))) await resolveCandidate(candidate, bias);
  const invalidations = [...invalidatedDirections].flatMap((selectedDirection) => [db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection), db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction=?").bind(installationId, planId, selectedDirection)]);
  if (updates.length) await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(new Date().toISOString(), installationId, planId, plan.revision)], [...invalidations, ...updates]);
  return planDetail(db, planId);
}

export async function carpoolRoute(db: D1Database, actor: string, request: Request, input?: unknown, geocoder?: CarpoolGeocodeTransport, meetingAccess?: MeetingReferenceAccess): Promise<RouteResult> {
  const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean); const planId = parts[3] ? decodeURIComponent(parts[3]) : undefined;
  if (url.pathname === "/admin/carpool/meeting-links" && request.method === "GET") return { status: 200, body: await readCarpoolMeetingLinks(db, meetingAccess) };
  if (url.pathname === "/admin/carpool/context" && request.method === "GET") {
    const [plans, members, profiles] = await Promise.all([
      db.prepare("SELECT * FROM carpool_plans WHERE installation_id=? AND archived=0 ORDER BY updated_at DESC,id").bind(installationId).all<Row>(),
      listActiveRosterIdentities(db, installationId),
      db.prepare("SELECT header_key,mapping_json FROM carpool_import_profiles WHERE installation_id=? ORDER BY updated_at DESC LIMIT 25").bind(installationId).all<Row>(),
    ]);
    const importProfiles = (profiles.results ?? []).flatMap((row) => {
      try { const mapping = JSON.parse(String(row.mapping_json)); return object(mapping) ? [{ headerKey: String(row.header_key), mapping }] : []; }
      catch { return []; }
    });
    const selected = url.searchParams.get("planId"); const detail = selected ? await planDetail(db, selected) : null;
    const [meetingChoices, relatedMeeting] = await Promise.all([meetingAccess?.list() ?? [], detail?.plan.meetingId && meetingAccess ? meetingAccess.find(String(detail.plan.meetingId)) : null]);
    return { status: 200, body: { plans: (plans.results ?? []).map(serializePlan), members: members.results ?? [], importProfiles, geocodingConfigured: Boolean(geocoder), meetingReferencesAvailable: Boolean(meetingAccess), meetingChoices, relatedMeeting, detail } };
  }
  if (url.pathname === "/admin/carpool/plans" && request.method === "POST") return { status: 201, body: await createCarpoolPlan(db, actor, input, meetingAccess) };
  if (url.pathname === "/admin/carpool/restore" && request.method === "POST") return { status: 201, body: await restorePlan(db, actor, input) };
  if (planId && parts.length === 4 && request.method === "DELETE") {
    await requirePlan(db, planId);
    const results = await db.batch([
      db.prepare("DELETE FROM carpool_plans WHERE installation_id=? AND id=?").bind(installationId, planId),
      audit(db, actor, "carpool.plan_deleted", planId),
    ]);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) throw new HttpError(409, "Carpool event could not be deleted");
    return { status: 200, body: { deleted: true } };
  }
  if (planId && parts.length === 4 && request.method === "PATCH") {
    const existing = await requirePlan(db, planId); const value = planInput(input, existing); const now = new Date().toISOString();
    const results = await withCarpoolMeetingLink(db, carpoolMeetingId(existing.meeting_id), value.meetingId, meetingAccess, (authorized) => guardedMutationBatch(authorized, [authorized.prepare("UPDATE carpool_plans SET title=?,destination=?,meeting_id=?,event_reference=?,event_title_snapshot=?,event_starts_at_snapshot=?,radius_miles=?,preferred_radius_miles=?,notes=?,archived=?,revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(value.title, value.destination, value.meetingId, value.eventReference, value.eventTitleSnapshot, value.eventStartsAtSnapshot, value.radiusMiles, value.preferredRadiusMiles, value.notes, value.archived ? 1 : 0, now, installationId, planId, value.revision)], [audit(authorized, actor, "carpool.plan_updated", planId)])); if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Carpool plan changed; reload before saving"); return { status: 200, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "people" && parts.length === 5 && request.method === "POST") {
    const plan = await requirePlan(db, planId); const value = personInput(input); if (value.memberId && !await activeRosterIdentity(db, installationId, value.memberId)) throw new HttpError(400, "Choose an active roster member or leave the participant unlinked"); const currentCount = await db.prepare("SELECT COUNT(*) AS count FROM carpool_people WHERE installation_id=? AND plan_id=?").bind(installationId, planId).first<{ count: number }>(); if (Number(currentCount?.count ?? 0) >= 500) throw new HttpError(400, "A Carpool plan may contain at most 500 participants"); const id = crypto.randomUUID(); const now = new Date().toISOString();
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [db.prepare("INSERT INTO carpool_people(installation_id,plan_id,id,member_id,display_name,contact,outbound_status,outbound_address,outbound_lat,outbound_lon,outbound_seats,return_status,return_address,return_lat,return_lon,return_seats,return_same_as_outbound,notes,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, id, value.memberId, value.displayName, value.contact, value.outboundStatus, value.outboundAddress, value.outboundLatitude, value.outboundLongitude, value.outboundSeats, value.returnStatus, value.returnAddress, value.returnLatitude, value.returnLongitude, value.returnSeats, value.returnSameAsOutbound ? 1 : 0, value.notes, 0, now, now), audit(db, actor, "carpool.participant_added", planId, { participantId: id, rosterLinked: Boolean(value.memberId) })]); return { status: 201, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "people" && parts[5] && request.method === "PATCH") {
    const personId = decodeURIComponent(parts[5]); const value = personInput(input); const [plan, existing] = await Promise.all([requirePlan(db, planId), db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, personId).first<Row>()]); if (!existing) throw new HttpError(404, "Participant not found"); if (value.memberId && value.memberId !== existing.member_id && !await activeRosterIdentity(db, installationId, value.memberId)) throw new HttpError(400, "Choose an active roster member or leave the participant unlinked"); const now = new Date().toISOString(); const outboundChanged = ["outbound_status", "outbound_address", "outbound_lat", "outbound_lon", "outbound_seats"].some((key) => existing[key] !== ({ outbound_status: value.outboundStatus, outbound_address: value.outboundAddress, outbound_lat: value.outboundLatitude, outbound_lon: value.outboundLongitude, outbound_seats: value.outboundSeats } as Row)[key]); const returnChanged = ["return_status", "return_address", "return_lat", "return_lon", "return_seats"].some((key) => existing[key] !== ({ return_status: value.returnStatus, return_address: value.returnAddress, return_lat: value.returnLatitude, return_lon: value.returnLongitude, return_seats: value.returnSeats } as Row)[key]); const update = db.prepare("UPDATE carpool_people SET member_id=?,display_name=?,contact=?,outbound_status=?,outbound_address=?,outbound_lat=?,outbound_lon=?,outbound_seats=?,return_status=?,return_address=?,return_lat=?,return_lon=?,return_seats=?,return_same_as_outbound=?,notes=?,revision=revision+1,updated_at=? WHERE installation_id=? AND plan_id=? AND id=? AND revision=?").bind(value.memberId, value.displayName, value.contact, value.outboundStatus, value.outboundAddress, value.outboundLatitude, value.outboundLongitude, value.outboundSeats, value.returnStatus, value.returnAddress, value.returnLatitude, value.returnLongitude, value.returnSeats, value.returnSameAsOutbound ? 1 : 0, value.notes, now, installationId, planId, personId, value.revision); const following = [...(outboundChanged ? [db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction='outbound' AND (rider_id=? OR vehicle_person_id=?)").bind(installationId, planId, personId, personId), db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction='outbound' AND rider_id=?").bind(installationId, planId, personId)] : []), ...(returnChanged ? [db.prepare("DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction='return' AND (rider_id=? OR vehicle_person_id=?)").bind(installationId, planId, personId, personId), db.prepare("DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction='return' AND rider_id=?").bind(installationId, planId, personId)] : []), audit(db, actor, "carpool.participant_updated", planId, { participantId: personId, outboundInvalidated: outboundChanged, returnInvalidated: returnChanged })]; const results = await guardedMutationBatch(db, [update, db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], following); if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Participant changed; reload before saving"); return { status: 200, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "people" && parts[5] && request.method === "DELETE") {
    const personId = decodeURIComponent(parts[5]); const plan = await requirePlan(db, planId);
    const existing = await db.prepare("SELECT id FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, personId).first<{ id: string }>();
    if (!existing) throw new HttpError(404, "Participant not found");
    const results = await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(new Date().toISOString(), installationId, planId, plan.revision)], [db.prepare("DELETE FROM carpool_people WHERE installation_id=? AND plan_id=? AND id=?").bind(installationId, planId, personId), audit(db, actor, "carpool.participant_removed", planId, { participantId: personId })]);
    if (results[0]?.meta?.changes !== 1 || results.at(-1)?.meta?.changes !== 1) throw new HttpError(409, "Participant could not be removed");
    return { status: 200, body: await planDetail(db, planId) };
  }
  if (planId && parts[4] === "import" && request.method === "POST") {
    const plan = await requirePlan(db, planId); if (!object(input) || typeof input.csv !== "string" || !object(input.mapping)) throw new HttpError(400, "Provide CSV contents and a column mapping");
    let imported: ReturnType<typeof mapCarpoolCsv>; try { imported = mapCarpoolCsv(input.csv, input.mapping as CarpoolColumnMapping); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "CSV could not be read"); }
    if (imported.issues.length) { const details = imported.issues.slice(0, 10).map((issue) => `Row ${issue.row}: ${issue.message}`); if (imported.issues.length > details.length) details.push(`${imported.issues.length - details.length} more row issues are not shown.`); return { status: 422, body: { error: "Some CSV rows need attention before they can be imported.", details, issues: imported.issues } }; }
    const [existingResult, rosterResult] = await Promise.all([db.prepare("SELECT * FROM carpool_people WHERE installation_id=? AND plan_id=?").bind(installationId, planId).all<Row>(), listActiveRosterIdentities(db, installationId)]);
    const existingRows = existingResult.results ?? []; const existingByIdentity = new Map(existingRows.filter((row) => typeof row.import_identity === "string").map((row) => [String(row.import_identity), row])); const rosterByExternalId = new Map((rosterResult.results ?? []).map((member) => [member.externalId.toLocaleLowerCase(), member]));
    const now = new Date().toISOString(); const headersKey = imported.headers.join("\u001f"); let added = 0; let merged = 0; const statements = []; const invalidateOutbound = new Set<string>(); const invalidateReturn = new Set<string>();
    for (const person of imported.people) {
      const existing = existingByIdentity.get(person.importIdentity); const member = person.memberExternalId ? rosterByExternalId.get(person.memberExternalId.toLocaleLowerCase()) : undefined; const incoming = importSnapshot(person, member?.id ?? null);
      if (existing) {
        merged += 1; const sourceMerge = mergeImportSnapshot(existing, incoming);
        statements.push(db.prepare("UPDATE carpool_people SET member_id=?,display_name=?,contact=?,source_row=?,import_snapshot_json=?,outbound_status=?,outbound_address=?,outbound_lat=?,outbound_lon=?,outbound_seats=?,return_status=?,return_address=?,return_lat=?,return_lon=?,return_seats=?,return_same_as_outbound=?,notes=?,revision=revision+1,updated_at=? WHERE installation_id=? AND plan_id=? AND id=?").bind(sourceMerge.merged.member_id, sourceMerge.merged.display_name, sourceMerge.merged.contact, person.sourceRow, JSON.stringify(incoming), sourceMerge.merged.outbound_status, sourceMerge.merged.outbound_address, sourceMerge.merged.outbound_lat, sourceMerge.merged.outbound_lon, sourceMerge.merged.outbound_seats, sourceMerge.merged.return_status, sourceMerge.merged.return_address, sourceMerge.merged.return_lat, sourceMerge.merged.return_lon, sourceMerge.merged.return_seats, sourceMerge.merged.return_same_as_outbound, sourceMerge.merged.notes, now, installationId, planId, existing.id));
        if (sourceMerge.outboundUpdated) invalidateOutbound.add(String(existing.id));
        if (sourceMerge.returnUpdated) invalidateReturn.add(String(existing.id));
      }
      else { added += 1; statements.push(db.prepare("INSERT INTO carpool_people(installation_id,plan_id,id,member_id,display_name,contact,source_row,import_identity,import_snapshot_json,outbound_status,outbound_address,outbound_lat,outbound_lon,outbound_seats,return_status,return_address,return_lat,return_lon,return_seats,return_same_as_outbound,notes,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(installationId, planId, crypto.randomUUID(), member?.id ?? null, person.displayName, person.contact, person.sourceRow, person.importIdentity, JSON.stringify(incoming), person.outboundStatus, person.outboundAddress, person.outboundLatitude, person.outboundLongitude, person.outboundSeats, person.returnStatus, person.returnAddress, person.returnLatitude, person.returnLongitude, person.returnSeats, person.returnSameAsOutbound ? 1 : 0, person.notes, 0, now, now)); }
    }
    if (existingRows.length + added > 500) throw new HttpError(400, "A Carpool plan may contain at most 500 participants");
    for (const [selectedDirection, ids] of [["outbound", invalidateOutbound], ["return", invalidateReturn]] as const) if (ids.size) { const values = [...ids]; const placeholders = values.map(() => "?").join(","); statements.push(db.prepare(`DELETE FROM carpool_assignments WHERE installation_id=? AND plan_id=? AND direction=? AND (rider_id IN (${placeholders}) OR vehicle_person_id IN (${placeholders}))`).bind(installationId, planId, selectedDirection, ...values, ...values), db.prepare(`DELETE FROM carpool_unresolved WHERE installation_id=? AND plan_id=? AND direction=? AND rider_id IN (${placeholders})`).bind(installationId, planId, selectedDirection, ...values)); }
    await guardedMutationBatch(db, [db.prepare("UPDATE carpool_plans SET revision=revision+1,updated_at=? WHERE installation_id=? AND id=? AND revision=?").bind(now, installationId, planId, plan.revision)], [...statements, db.prepare("INSERT INTO carpool_import_profiles(installation_id,header_key,mapping_json,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(installation_id,header_key) DO UPDATE SET mapping_json=excluded.mapping_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(installationId, headersKey, JSON.stringify(input.mapping), actor, now), audit(db, actor, "carpool.csv_imported", planId, { rows: imported.people.length, added, merged })]); return { status: 201, body: { imported: imported.people.length, added, merged, detail: await planDetail(db, planId) } };
  }
  if (planId && parts[4] === "generate" && parts[5] && request.method === "POST") return { status: 200, body: await generate(db, actor, planId, parts[5] === "both" ? "both" : direction(parts[5])) };
  if (planId && parts[4] === "assignments" && parts[5] && parts[6] && request.method === "PATCH") return { status: 200, body: await assignmentAction(db, actor, planId, direction(parts[5]), decodeURIComponent(parts[6]), input) };
  if (planId && parts[4] === "export" && request.method === "GET") return { status: 200, body: await exportPlan(db, planId, url.searchParams.get("kind") ?? "outbound") };
  if (planId && parts[4] === "locations" && parts[5] === "resolve" && request.method === "POST") return { status: 200, body: await resolveLocations(db, planId, geocoder, object(input) && input.refreshAmbiguous === true) };
  throw new HttpError(404, "Carpool route not found");
}
