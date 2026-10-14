import { HttpError } from "./http-error.ts";
import { suggestCarpoolPlan, legFor, type CarpoolPerson, type CarpoolAssignment, type CarpoolDirection, type CarpoolUnresolved } from "./carpool-planning.ts";
import { carpoolGroupColors, type CarpoolGroupSetting } from "../../../packages/shared/src/carpool-groups.ts";

export type DirectionalAssignment = CarpoolAssignment & { direction: CarpoolDirection };
export type DirectionalIssue = CarpoolUnresolved & { direction: CarpoolDirection };
export type RebuildSnapshot = { version: 1; revision: number; directions: CarpoolDirection[]; radiusMiles: number; preferredRadiusMiles: number; assignments: DirectionalAssignment[]; unresolved: DirectionalIssue[] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const id = (value: unknown) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128;
const trip = (value: unknown) => value === "outbound" || value === "return";
const finite = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function validateGroupSettings(value: unknown, participantIds?: Set<string>): CarpoolGroupSetting[] {
  if (!Array.isArray(value) || value.length > 1000) throw new HttpError(400, "Carpool group settings are invalid");
  const seen = new Set<string>();
  for (const item of value) {
    if (!object(item) || !fields(item, ["direction", "vehiclePersonId", "label", "color"]) || !trip(item.direction) || !id(item.vehiclePersonId) || typeof item.label !== "string" || item.label.length > 80 || item.label.trim() !== item.label || !carpoolGroupColors.some(color => color.id === item.color) || participantIds && !participantIds.has(String(item.vehiclePersonId))) throw new HttpError(400, "Carpool group settings contain an invalid group");
    const key = `${item.direction}:${item.vehiclePersonId}`; if (seen.has(key)) throw new HttpError(400, "Carpool group settings contain duplicate groups"); seen.add(key);
  }
  return value as CarpoolGroupSetting[];
}
export function parseGroupSettings(value: unknown): CarpoolGroupSetting[] {
  try { return validateGroupSettings(value === undefined ? [] : JSON.parse(String(value))); } catch (caught) { if (caught instanceof HttpError) throw caught; throw new HttpError(400, "Carpool group settings could not be read"); }
}

export function validateRebuildSnapshot(value: unknown): RebuildSnapshot {
  if (!object(value) || !fields(value, ["version", "revision", "directions", "radiusMiles", "preferredRadiusMiles", "assignments", "unresolved"]) || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Array.isArray(value.directions) || value.directions.length < 1 || value.directions.length > 2 || value.directions.some(value => !trip(value)) || new Set(value.directions).size !== value.directions.length || !finite(value.radiusMiles, .5, 250) || !finite(value.preferredRadiusMiles, .5, value.radiusMiles) || !Array.isArray(value.assignments) || value.assignments.length > 1000 || !Array.isArray(value.unresolved) || value.unresolved.length > 1000) throw new HttpError(400, "Carpool rebuild recovery data is invalid");
  const assigned = new Set<string>(); const issues = new Set<string>();
  for (const item of value.assignments) {
    if (!object(item) || !fields(item, ["direction", "riderId", "vehiclePersonId", "distanceMiles", "locked", "manual"]) || !value.directions.includes(item.direction) || !id(item.riderId) || !id(item.vehiclePersonId) || item.riderId === item.vehiclePersonId || !finite(item.distanceMiles, 0, 25000) || typeof item.locked !== "boolean" || typeof item.manual !== "boolean") throw new HttpError(400, "Carpool rebuild recovery contains an invalid assignment");
    const key = `${item.direction}:${item.riderId}`; if (assigned.has(key)) throw new HttpError(400, "Carpool rebuild recovery contains duplicate assignments"); assigned.add(key);
  }
  for (const item of value.unresolved) {
    if (!object(item) || !fields(item, ["direction", "riderId", "reason", "detail"]) || !value.directions.includes(item.direction) || !id(item.riderId) || !["needs-review", "seat-shortage", "no-nearby-car", "no-nearby-seat"].includes(String(item.reason)) || typeof item.detail !== "string" || !item.detail.trim() || item.detail.length > 500) throw new HttpError(400, "Carpool rebuild recovery contains an invalid exception");
    const key = `${item.direction}:${item.riderId}`; if (issues.has(key) || assigned.has(key)) throw new HttpError(400, "Carpool rebuild recovery contains conflicting exceptions"); issues.add(key);
  }
  return value as RebuildSnapshot;
}
export function parseRebuildSnapshot(value: unknown): RebuildSnapshot | null {
  if (value === undefined || value === null) return null;
  try { return validateRebuildSnapshot(JSON.parse(String(value))); } catch (caught) { if (caught instanceof HttpError) throw caught; throw new HttpError(400, "Carpool rebuild recovery could not be read"); }
}
export function checkRebuildParticipants(snapshot: RebuildSnapshot, people: CarpoolPerson[]) {
  const byId = new Map(people.map(person => [person.id, person])); const used = new Map<string, number>();
  for (const item of snapshot.assignments) {
    const rider = byId.get(item.riderId); const driver = byId.get(item.vehiclePersonId); const riderLeg = rider && legFor(rider, item.direction); const driverLeg = driver && legFor(driver, item.direction);
    if (!riderLeg || !driverLeg || riderLeg.status !== "needs-ride" || driverLeg.status !== "offer" || riderLeg.latitude === null || riderLeg.longitude === null || driverLeg.latitude === null || driverLeg.longitude === null) throw new HttpError(409, "The previous groups are no longer eligible. Review participants before rebuilding.");
    const key = `${item.direction}:${item.vehiclePersonId}`; const seats = (used.get(key) ?? 0) + 1; if (seats > (driverLeg.seats ?? 0)) throw new HttpError(409, "The previous groups exceed the current passenger capacity"); used.set(key, seats);
  }
  if (snapshot.unresolved.some(item => !byId.has(item.riderId))) throw new HttpError(409, "The previous exceptions refer to a removed participant");
}

export function proposeCarpoolRebuild({ people, assignments, directions, radiusMiles, preferredRadiusMiles }: { people: CarpoolPerson[]; assignments: DirectionalAssignment[]; directions: CarpoolDirection[]; radiusMiles: number; preferredRadiusMiles: number }) {
  const proposed: DirectionalAssignment[] = []; const unresolved: DirectionalIssue[] = [];
  const processed = new Set<CarpoolDirection>();
  for (const direction of directions) {
    const other = direction === "outbound" ? "return" : "outbound";
    const suggestion = suggestCarpoolPlan({ people, direction, radiusMiles, preferredRadiusMiles, existing: assignments.filter(item => item.direction === direction), otherDirection: processed.has(other) ? proposed.filter(item => item.direction === other) : assignments.filter(item => item.direction === other) });
    if (suggestion.conflicts.length) throw new HttpError(409, "Resolve locked assignments before rebuilding", suggestion.conflicts);
    proposed.push(...suggestion.assignments.map(item => ({ ...item, direction }))); unresolved.push(...suggestion.unresolved.map(item => ({ ...item, direction })));
    processed.add(direction);
  }
  const changes = directions.flatMap(direction => {
    const before = new Map(assignments.filter(item => item.direction === direction).map(item => [item.riderId, item])); const after = new Map(proposed.filter(item => item.direction === direction).map(item => [item.riderId, item]));
    return [...new Set([...before.keys(), ...after.keys()])].map(riderId => { const prior = before.get(riderId); const next = after.get(riderId); return { direction, riderId, beforeVehiclePersonId: prior?.vehiclePersonId ?? null, afterVehiclePersonId: next?.vehiclePersonId ?? null, change: !prior ? "added" : !next ? "removed" : prior.vehiclePersonId !== next.vehiclePersonId ? "moved" : "unchanged", locked: Boolean(next?.locked) }; });
  });
  const summary = directions.map(direction => ({ direction, assigned: proposed.filter(item => item.direction === direction).length, exceptions: unresolved.filter(item => item.direction === direction).length, added: changes.filter(item => item.direction === direction && item.change === "added").length, moved: changes.filter(item => item.direction === direction && item.change === "moved").length, removed: changes.filter(item => item.direction === direction && item.change === "removed").length, unchanged: changes.filter(item => item.direction === direction && item.change === "unchanged").length, lockedPreserved: proposed.filter(item => item.direction === direction && item.locked).length }));
  return { assignments: proposed, unresolved, changes, summary };
}
