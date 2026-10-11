import { HttpError } from "./http-error.ts";
import { carpoolMeetingId } from "./carpool-meeting-links.ts";

type Row = Record<string, unknown>;
export type CarpoolBackupTables = {
  carpool_plans: Row[];
  carpool_people: Row[];
  carpool_assignments: Row[];
  carpool_unresolved: Row[];
};

const key = (row: Row, suffix = "") => `${String(row.installation_id)}:${String(row.plan_id)}:${String(row.id ?? row.rider_id)}${suffix}`;

export function validateCarpoolBackupTables(tables: CarpoolBackupTables) {
  for (const row of tables.carpool_plans) carpoolMeetingId(row.meeting_id);
  const plans = new Set(tables.carpool_plans.map((row) => `${String(row.installation_id)}:${String(row.id)}`));
  if (plans.size !== tables.carpool_plans.length) throw new HttpError(400, "Backup contains duplicate Carpool plans");
  const people = new Map(tables.carpool_people.map((row) => [key(row), row]));
  if (people.size !== tables.carpool_people.length) throw new HttpError(400, "Backup contains duplicate Carpool participants");
  const counts = new Map<string, number>();
  for (const row of tables.carpool_people) {
    const plan = `${String(row.installation_id)}:${String(row.plan_id)}`; if (!plans.has(plan)) throw new HttpError(400, "Backup Carpool participant references a missing plan"); counts.set(plan, (counts.get(plan) ?? 0) + 1);
  }
  if ([...counts.values()].some((count) => count > 500)) throw new HttpError(400, "Backup Carpool plan contains too many participants");
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
