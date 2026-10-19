export type CarpoolTripDirection = "outbound" | "return";
export type CarpoolTripScope = "both" | CarpoolTripDirection;
export const carpoolDirections = (scope: CarpoolTripScope = "both"): CarpoolTripDirection[] => scope === "both" ? ["outbound", "return"] : [scope];
export type CarpoolTravelStatus = "offer" | "arranged" | "needs-ride" | "transit" | "unknown";
export type CarpoolStatePerson = {
  id: string; displayName: string;
  outboundStatus: CarpoolTravelStatus; outboundAddress: string; outboundLatitude: number | null; outboundLongitude: number | null; outboundSeats: number | null;
  returnStatus: CarpoolTravelStatus; returnAddress: string; returnLatitude: number | null; returnLongitude: number | null; returnSeats: number | null;
  outboundLocationSource?: "lookup" | "manual" | "no-match" | null; returnLocationSource?: "lookup" | "manual" | "no-match" | null;
};
export type CarpoolStateAssignment = { riderId: string; vehiclePersonId: string; direction: CarpoolTripDirection };
export type CarpoolStateIssue = { riderId: string; direction: CarpoolTripDirection; reason: string; detail: string };
export function carpoolDistanceMiles(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitude = radians(second.latitude - first.latitude); const longitude = radians(second.longitude - first.longitude);
  const value = Math.sin(latitude / 2) ** 2 + Math.sin(longitude / 2) ** 2 * Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude));
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

/** Derived from current participants, so edits and invalidation cannot hide riders. */
export function carpoolReadiness(people: readonly CarpoolStatePerson[], assignments: readonly CarpoolStateAssignment[], unresolved: readonly CarpoolStateIssue[] = [], scope: CarpoolTripScope = "both") {
  const directions = Object.fromEntries((["outbound", "return"] as const).map(direction => {
    const byId = new Map(people.map(person => [person.id, person]));
    const assignedIds = new Set<string>();
    const occupants = new Map<string, number>();
    for (const assignment of assignments.filter(item => item.direction === direction)) {
      const rider = byId.get(assignment.riderId); const driver = byId.get(assignment.vehiclePersonId);
      if (!rider || !driver || rider.id === driver.id || rider[`${direction}Status`] !== "needs-ride" || driver[`${direction}Status`] !== "offer") continue;
      if ([rider, driver].some(person => !person[`${direction}Address`].trim() || person[`${direction}Latitude`] === null || person[`${direction}Longitude`] === null)) continue;
      const used = occupants.get(driver.id) ?? 0;
      if (used >= (driver[`${direction}Seats`] ?? 0) || assignedIds.has(rider.id)) continue;
      occupants.set(driver.id, used + 1); assignedIds.add(rider.id);
    }
    const issues: CarpoolStateIssue[] = [];
    for (const person of people) {
      const status = person[`${direction}Status`]; let detail = "";
      if (status === "unknown") detail = "Choose a transportation status.";
      else if (["offer", "needs-ride"].includes(status) && !person[`${direction}Address`].trim()) detail = "Add a pickup or drop-off address.";
      else if (status === "offer" && (!Number.isInteger(person[`${direction}Seats`]) || (person[`${direction}Seats`] ?? -1) < 0)) detail = "Enter a whole-number passenger seat count.";
      else if (["offer", "needs-ride"].includes(status) && (person[`${direction}Latitude`] === null || person[`${direction}Longitude`] === null)) {
        if (person[`${direction}LocationSource`] === "no-match") detail = "No clear address match was found. Verify the address or place a manual pin.";
        else { issues.push({ riderId: person.id, direction, reason: "location-pending", detail: "Waiting for automatic location lookup." }); continue; }
      }
      if (detail) issues.push({ riderId: person.id, direction, reason: "needs-review", detail });
      else if (status === "needs-ride" && !assignedIds.has(person.id)) issues.push(unresolved.find(item => item.direction === direction && item.riderId === person.id) ?? { riderId: person.id, direction, reason: "unassigned", detail: "Choose a car or build suggestions for this rider." });
    }
    return [direction, { requests: people.filter(person => person[`${direction}Status`] === "needs-ride").length, seats: people.filter(person => person[`${direction}Status`] === "offer").reduce((sum, person) => sum + (person[`${direction}Seats`] ?? 0), 0), assigned: assignedIds.size, issues, ready: people.length > 0 && issues.length === 0 }];
  })) as Record<CarpoolTripDirection, { requests: number; seats: number; assigned: number; issues: CarpoolStateIssue[]; ready: boolean }>;
  return { state: !people.length ? "draft" : carpoolDirections(scope).every(direction => directions[direction].ready) ? "ready" : "needs-attention", directions } as const;
}
