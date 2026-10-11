export type CarpoolDirection = "outbound" | "return";
export type CarpoolStatus = "offer" | "arranged" | "needs-ride" | "transit" | "unknown";

export type CarpoolLeg = {
  status: CarpoolStatus;
  address: string;
  latitude: number | null;
  longitude: number | null;
  seats: number | null;
};

export type CarpoolPerson = {
  id: string;
  displayName: string;
  outbound: CarpoolLeg;
  return: CarpoolLeg;
};

export type CarpoolAssignment = {
  riderId: string;
  vehiclePersonId: string;
  distanceMiles: number;
  locked: boolean;
  manual: boolean;
};

export type CarpoolUnresolved = {
  riderId: string;
  reason: "needs-review" | "seat-shortage" | "no-nearby-car" | "no-nearby-seat";
  detail: string;
};

export type CarpoolPlanSuggestion = {
  assignments: CarpoolAssignment[];
  unresolved: CarpoolUnresolved[];
  conflicts: string[];
};

export const legFor = (person: CarpoolPerson, direction: CarpoolDirection) => direction === "outbound" ? person.outbound : person.return;

export function distanceMiles(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitude = radians(second.latitude - first.latitude);
  const longitude = radians(second.longitude - first.longitude);
  const firstLatitude = radians(first.latitude);
  const secondLatitude = radians(second.latitude);
  const value = Math.sin(latitude / 2) ** 2 + Math.sin(longitude / 2) ** 2 * Math.cos(firstLatitude) * Math.cos(secondLatitude);
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function coordinates(leg: CarpoolLeg) {
  return leg.latitude === null || leg.longitude === null ? null : { latitude: leg.latitude, longitude: leg.longitude };
}

type FlowEdge = { to: number; reverse: number; capacity: number; cost: number; original: number };
function addFlowEdge(graph: FlowEdge[][], from: number, to: number, capacity: number, cost: number) {
  graph[from]!.push({ to, reverse: graph[to]!.length, capacity, cost, original: capacity });
  graph[to]!.push({ to: from, reverse: graph[from]!.length - 1, capacity: 0, cost: -cost, original: 0 });
}
function minCostMaximumFlow(graph: FlowEdge[][], source: number, sink: number) {
  const potential = Array(graph.length).fill(0) as number[];
  while (true) {
    const distances = Array(graph.length).fill(Number.POSITIVE_INFINITY) as number[];
    const previousNode = Array(graph.length).fill(-1) as number[];
    const previousEdge = Array(graph.length).fill(-1) as number[];
    const visited = new Set<number>(); distances[source] = 0;
    while (visited.size < graph.length) {
      let node = -1; let best = Number.POSITIVE_INFINITY;
      for (let index = 0; index < graph.length; index += 1) if (!visited.has(index) && distances[index]! < best) { node = index; best = distances[index]!; }
      if (node < 0) break; visited.add(node);
      graph[node]!.forEach((edge, edgeIndex) => {
        if (edge.capacity < 1) return;
        const candidate = distances[node]! + edge.cost + potential[node]! - potential[edge.to]!;
        if (candidate >= distances[edge.to]!) return;
        distances[edge.to] = candidate; previousNode[edge.to] = node; previousEdge[edge.to] = edgeIndex;
      });
    }
    if (previousNode[sink] < 0) return;
    for (let index = 0; index < graph.length; index += 1) if (Number.isFinite(distances[index])) potential[index] += distances[index]!;
    for (let node = sink; node !== source; node = previousNode[node]!) {
      const from = previousNode[node]!; const edge = graph[from]![previousEdge[node]!]!;
      edge.capacity -= 1; graph[node]![edge.reverse]!.capacity += 1;
    }
  }
}

/**
 * Produces capacity-safe straight-line geographic suggestions. This is not a
 * route optimizer and never invents stop order, transit points, or meeting places.
 */
export function suggestCarpoolPlan(input: {
  people: readonly CarpoolPerson[];
  direction: CarpoolDirection;
  radiusMiles: number;
  preferredRadiusMiles: number;
  existing: readonly CarpoolAssignment[];
  otherDirection: readonly CarpoolAssignment[];
}): CarpoolPlanSuggestion {
  const { people, direction, radiusMiles, preferredRadiusMiles } = input;
  const byId = new Map(people.map((person) => [person.id, person]));
  const offers = people.filter((person) => {
    const leg = legFor(person, direction);
    return leg.status === "offer" && (leg.seats ?? 0) > 0 && coordinates(leg);
  });
  const riders = people.filter((person) => legFor(person, direction).status === "needs-ride" && coordinates(legFor(person, direction)));
  const requiredRiderIds = new Set(riders.map((person) => person.id));
  const offerIds = new Set(offers.map((person) => person.id));
  const remaining = new Map(offers.map((person) => [person.id, legFor(person, direction).seats ?? 0]));
  const assignments: CarpoolAssignment[] = [];
  const assigned = new Set<string>();
  const conflicts: string[] = [];

  for (const locked of input.existing.filter((assignment) => assignment.locked)) {
    const rider = byId.get(locked.riderId);
    const offer = byId.get(locked.vehiclePersonId);
    const riderLeg = rider && legFor(rider, direction);
    const offerLeg = offer && legFor(offer, direction);
    if (!rider || !offer || !requiredRiderIds.has(rider.id) || !offerIds.has(offer.id) || !coordinates(riderLeg!) || !coordinates(offerLeg!)) {
      conflicts.push(`Locked assignment for ${rider?.displayName ?? locked.riderId} is no longer eligible.`);
      continue;
    }
    if ((remaining.get(offer.id) ?? 0) < 1) {
      conflicts.push(`Locked assignment for ${rider.displayName} exceeds ${offer.displayName}'s current capacity.`);
      continue;
    }
    assignments.push({ ...locked }); assigned.add(rider.id); remaining.set(offer.id, (remaining.get(offer.id) ?? 0) - 1);
  }
  if (conflicts.length) return { assignments: [...input.existing], unresolved: [], conflicts };

  const continuity = new Set(input.otherDirection.map((assignment) => `${assignment.riderId}:${assignment.vehiclePersonId}`));
  const openRiders = riders.filter((rider) => !assigned.has(rider.id));
  const openOffers = offers.filter((offer) => (remaining.get(offer.id) ?? 0) > 0);
  const source = 0; const riderOffset = 1; const offerOffset = riderOffset + openRiders.length; const sink = offerOffset + openOffers.length;
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  openRiders.forEach((_, index) => addFlowEdge(graph, source, riderOffset + index, 1, 0));
  openOffers.forEach((offer, index) => addFlowEdge(graph, offerOffset + index, sink, remaining.get(offer.id) ?? 0, 0));
  openRiders.forEach((rider, riderIndex) => openOffers.forEach((offer, offerIndex) => {
    const miles = distanceMiles(coordinates(legFor(rider, direction))!, coordinates(legFor(offer, direction))!);
    if (miles > radiusMiles) return;
    const excess = Math.max(0, miles - preferredRadiusMiles);
    const weighted = miles + excess * 2 + excess * excess * 0.75;
    const cost = Math.max(0, Math.round(weighted * 1000) - (continuity.has(`${rider.id}:${offer.id}`) ? 350 : 0));
    addFlowEdge(graph, riderOffset + riderIndex, offerOffset + offerIndex, 1, cost);
  }));
  minCostMaximumFlow(graph, source, sink);
  openRiders.forEach((rider, riderIndex) => graph[riderOffset + riderIndex]!.forEach((edge) => {
    if (edge.to < offerOffset || edge.to >= sink || edge.original !== 1 || edge.capacity !== 0) return;
    const offer = openOffers[edge.to - offerOffset]!;
    assignments.push({ riderId: rider.id, vehiclePersonId: offer.id, distanceMiles: distanceMiles(coordinates(legFor(rider, direction))!, coordinates(legFor(offer, direction))!), locked: false, manual: false });
    assigned.add(rider.id);
  }));

  const totalSeats = offers.reduce((sum, offer) => sum + (legFor(offer, direction).seats ?? 0), 0);
  const unresolved: CarpoolUnresolved[] = [];
  for (const person of people) {
    const leg = legFor(person, direction);
    if (leg.status === "unknown" || (leg.status === "needs-ride" && !coordinates(leg))) unresolved.push({ riderId: person.id, reason: "needs-review", detail: leg.status === "unknown" ? "Transportation status needs review." : "Add a usable address and coordinates." });
  }
  for (const rider of riders.filter((person) => !assigned.has(person.id))) {
    const nearby = offers.filter((offer) => distanceMiles(coordinates(legFor(rider, direction))!, coordinates(legFor(offer, direction))!) <= radiusMiles);
    const reason: CarpoolUnresolved["reason"] = totalSeats < riders.length ? "seat-shortage" : nearby.length ? "no-nearby-seat" : "no-nearby-car";
    const detail = reason === "seat-shortage" ? "Total ride demand exceeds available seats."
      : reason === "no-nearby-car" ? `No eligible car is within ${radiusMiles} miles.`
      : "Nearby cars exist, but their seats are already assigned.";
    unresolved.push({ riderId: rider.id, reason, detail });
  }
  return { assignments, unresolved, conflicts: [] };
}

export function moveCarpoolAssignment(input: {
  people: readonly CarpoolPerson[];
  direction: CarpoolDirection;
  assignments: readonly CarpoolAssignment[];
  riderId: string;
  vehiclePersonId: string;
}): { assignments?: CarpoolAssignment[]; error?: string } {
  const rider = input.people.find((person) => person.id === input.riderId);
  const vehicle = input.people.find((person) => person.id === input.vehiclePersonId);
  if (!rider || !vehicle) return { error: "The selected rider or car is no longer available." };
  const vehicleLeg = legFor(vehicle, input.direction);
  if (vehicleLeg.status !== "offer" || (vehicleLeg.seats ?? 0) < 1 || !coordinates(vehicleLeg) || !coordinates(legFor(rider, input.direction))) return { error: "The selected car is not eligible for this direction." };
  const occupants = input.assignments.filter((assignment) => assignment.vehiclePersonId === vehicle.id && assignment.riderId !== rider.id);
  if (occupants.length >= (vehicleLeg.seats ?? 0)) return { error: `${vehicle.displayName}'s car is full.` };
  const existing = input.assignments.find((assignment) => assignment.riderId === rider.id);
  if (existing?.locked) return { error: "Unlock this assignment before moving it." };
  const next = { riderId: rider.id, vehiclePersonId: vehicle.id, distanceMiles: distanceMiles(coordinates(legFor(rider, input.direction))!, coordinates(vehicleLeg)!), locked: false, manual: true };
  return { assignments: [...input.assignments.filter((assignment) => assignment.riderId !== rider.id), next] };
}

export function swapCarpoolAssignments(input: {
  people: readonly CarpoolPerson[];
  direction: CarpoolDirection;
  assignments: readonly CarpoolAssignment[];
  firstRiderId: string;
  secondRiderId: string;
}): { assignments?: CarpoolAssignment[]; error?: string } {
  const first = input.assignments.find((assignment) => assignment.riderId === input.firstRiderId);
  const second = input.assignments.find((assignment) => assignment.riderId === input.secondRiderId);
  if (!first || !second) return { error: "Both people must already be assigned." };
  if (first.locked || second.locked) return { error: "Unlock both assignments before swapping them." };
  if (first.vehiclePersonId === second.vehiclePersonId) return { assignments: [...input.assignments] };
  const firstRider = input.people.find((person) => person.id === first.riderId); const secondRider = input.people.find((person) => person.id === second.riderId);
  const firstVehicle = input.people.find((person) => person.id === second.vehiclePersonId); const secondVehicle = input.people.find((person) => person.id === first.vehiclePersonId);
  if (!firstRider || !secondRider || !firstVehicle || !secondVehicle) return { error: "The selected riders or cars are no longer available." };
  const firstCoordinates = coordinates(legFor(firstRider, input.direction)); const secondCoordinates = coordinates(legFor(secondRider, input.direction));
  const firstVehicleCoordinates = coordinates(legFor(firstVehicle, input.direction)); const secondVehicleCoordinates = coordinates(legFor(secondVehicle, input.direction));
  if (!firstCoordinates || !secondCoordinates || !firstVehicleCoordinates || !secondVehicleCoordinates) return { error: "Both assignments need resolved locations before swapping." };
  return { assignments: input.assignments.map((assignment) => assignment.riderId === first.riderId ? { ...assignment, vehiclePersonId: second.vehiclePersonId, distanceMiles: distanceMiles(firstCoordinates, firstVehicleCoordinates), manual: true }
    : assignment.riderId === second.riderId ? { ...assignment, vehiclePersonId: first.vehiclePersonId, distanceMiles: distanceMiles(secondCoordinates, secondVehicleCoordinates), manual: true }
    : assignment) };
}
