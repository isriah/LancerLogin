import { validateCarpoolSchedule } from "../../../packages/shared/src/carpool-schedule.ts";
import { HttpError } from "./http-error.ts";
import { carpoolMeetingId } from "./carpool-meeting-links.ts";
import { parseGroupSettings, parseRebuildSnapshot, checkRebuildParticipants } from "./carpool-rebuild.ts";
import { carpoolDirections, type CarpoolTripScope } from "../../../packages/shared/src/carpool-state.ts";
import type { CarpoolPerson } from "./carpool-planning.ts";

type Row = Record<string, unknown>;
export type CarpoolBackupTables = {
  carpool_settings?: Row[];
  carpool_plans: Row[];
  carpool_people: Row[];
  carpool_assignments: Row[];
  carpool_unresolved: Row[];
};

const key = (row: Row, suffix = "") => `${String(row.installation_id)}:${String(row.plan_id)}:${String(row.id ?? row.rider_id)}${suffix}`;

export function validateCarpoolBackupTables(tables: CarpoolBackupTables) {
  if ((tables.carpool_settings?.length ?? 0) > 1) throw new HttpError(400, "Backup contains duplicate Carpool settings");
  for (const row of tables.carpool_settings ?? []) {
    if (row.installation_id !== "primary" || typeof row.radius_miles !== "number" || !Number.isFinite(row.radius_miles) || row.radius_miles < 0.5 || row.radius_miles > 250 || typeof row.preferred_radius_miles !== "number" || !Number.isFinite(row.preferred_radius_miles) || row.preferred_radius_miles < 0.5 || row.preferred_radius_miles > row.radius_miles || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) throw new HttpError(400, "Backup contains invalid Carpool settings");
  }
  for (const row of tables.carpool_plans) {
    carpoolMeetingId(row.meeting_id);
    try { validateCarpoolSchedule({ timeZone: row.time_zone, outboundDepartureAt: row.outbound_departure_at, returnDepartureAt: row.return_departure_at }, (row.trip_scope ?? "both") as CarpoolTripScope); } catch (error) { throw new HttpError(400, "Backup contains invalid Carpool trip timing: " + (error as Error).message); }
    if (row.trip_scope !== undefined && !["both", "outbound", "return"].includes(String(row.trip_scope))) throw new HttpError(400, "Backup contains invalid Carpool trip scope");
  }
  const plans = new Set(tables.carpool_plans.map((row) => `${String(row.installation_id)}:${String(row.id)}`));
  if (plans.size !== tables.carpool_plans.length) throw new HttpError(400, "Backup contains duplicate Carpool plans");
  const people = new Map(tables.carpool_people.map((row) => [key(row), row]));
  if (people.size !== tables.carpool_people.length) throw new HttpError(400, "Backup contains duplicate Carpool participants");
  const counts = new Map<string, number>();
  for (const row of tables.carpool_people) {
    for (const direction of ["outbound", "return"]) {
      const source = row[`${direction}_location_source`]; const label = row[`${direction}_location_label`];
      if (source !== undefined && source !== null && !["lookup", "manual", "no-match"].includes(String(source))) throw new HttpError(400, "Backup contains invalid Carpool location provenance");
      if (label !== undefined && label !== null && (typeof label !== "string" || label.length > 500)) throw new HttpError(400, "Backup contains invalid Carpool matched address");
      if (source === "no-match" && (row[`${direction}_lat`] !== null || row[`${direction}_lon`] !== null) || ["lookup", "manual"].includes(String(source)) && (row[`${direction}_lat`] === null || row[`${direction}_lon`] === null)) throw new HttpError(400, "Backup Carpool location provenance does not match its pin");
    }
    const plan = `${String(row.installation_id)}:${String(row.plan_id)}`; if (!plans.has(plan)) throw new HttpError(400, "Backup Carpool participant references a missing plan"); counts.set(plan, (counts.get(plan) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count > 500)) throw new HttpError(400, "Backup Carpool plan contains too many participants");
  for (const row of tables.carpool_plans) {
    const rows = tables.carpool_people.filter(person => person.installation_id === row.installation_id && person.plan_id === row.id); const ids = new Set(rows.map(person => String(person.id)));
    const settings = parseGroupSettings(row.group_settings_json); if (settings.some(item => !ids.has(item.vehiclePersonId))) throw new HttpError(400, "Backup Carpool group settings refer to a missing participant");
    const snapshot = parseRebuildSnapshot(row.last_rebuild_json); if (snapshot && snapshot.revision > Number(row.revision)) throw new HttpError(400, "Backup Carpool rebuild recovery has a future revision");
    if (snapshot && snapshot.revision === row.revision) {
      if (snapshot.directions.some(trip => !carpoolDirections((row.trip_scope ?? "both") as CarpoolTripScope).includes(trip))) throw new HttpError(400, "Backup Carpool rebuild recovery refers to an unplanned direction");
      const people: CarpoolPerson[] = rows.map(person => ({ id: String(person.id), displayName: String(person.display_name), outbound: { status: person.outbound_status, address: person.outbound_address, latitude: person.outbound_lat, longitude: person.outbound_lon, seats: person.outbound_seats }, return: { status: person.return_status, address: person.return_address, latitude: person.return_lat, longitude: person.return_lon, seats: person.return_seats } } as CarpoolPerson));
      try { checkRebuildParticipants(snapshot, people); } catch { throw new HttpError(400, "Backup Carpool rebuild recovery is inconsistent with its participants"); }
    }
  }
  const assigned = new Set<string>(); const capacity = new Map<string, number>();
  for (const row of tables.carpool_assignments) {
    const direction = String(row.direction); const riderKey = `${String(row.installation_id)}:${String(row.plan_id)}:${String(row.rider_id)}`; const vehicleKey = `${String(row.installation_id)}:${String(row.plan_id)}:${String(row.vehicle_person_id)}`; const unique = `${direction}:${riderKey}`;
    if (assigned.has(unique)) throw new HttpError(400, "Backup contains duplicate Carpool assignments"); assigned.add(unique);
    const rider = people.get(riderKey); const vehicle = people.get(vehicleKey); if (!rider || !vehicle || riderKey === vehicleKey) throw new HttpError(400, "Backup Carpool assignment references an invalid participant");
    if (rider[`${direction}_status`] !== "needs-ride" || vehicle[`${direction}_status`] !== "offer") throw new HttpError(400, "Backup Carpool assignment uses an ineligible rider or car");
    const vehicleDirection = `${direction}:${vehicleKey}`; capacity.set(vehicleDirection, (capacity.get(vehicleDirection) ?? 0) + 1);
  }
  for (const [vehicleDirection, used] of capacity) { const separator = vehicleDirection.indexOf(":"); const direction = vehicleDirection.slice(0, separator); const vehicle = people.get(vehicleDirection.slice(separator + 1)); if (!vehicle || used > Number(vehicle[`${direction}_seats`] ?? 0)) throw new HttpError(400, "Backup Carpool assignment exceeds vehicle capacity"); }
  const unresolved = new Set<string>();
  for (const row of tables.carpool_unresolved) {
    const unique = `${String(row.direction)}:${String(row.installation_id)}:${String(row.plan_id)}:${String(row.rider_id)}`;
    if (unresolved.has(unique)) throw new HttpError(400, "Backup contains duplicate unresolved Carpool rides"); unresolved.add(unique);
    if (!people.has(`${String(row.installation_id)}:${String(row.plan_id)}:${String(row.rider_id)}`)) throw new HttpError(400, "Backup unresolved Carpool ride references a missing participant");
    if (assigned.has(unique)) throw new HttpError(400, "Backup marks a Carpool rider assigned and unresolved in the same direction");
  }
}
