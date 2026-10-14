import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "./modal-focus";
import { carpoolDistanceMiles } from "../../../packages/shared/src/carpool-state";
import type { Person, Assignment, Direction } from "./carpool-model";

export function CarpoolAssignmentEditor({ riderId, action, people, assignments, direction, maximumMiles, busy, error, onApply, onClose }: {
  riderId: string; action: "move" | "swap"; people: Person[]; assignments: Assignment[]; direction: Direction; maximumMiles: number; busy: boolean; error?: string;
  onApply: (body: { action: "move"; vehiclePersonId: string } | { action: "swap"; secondRiderId: string } | { action: "unassign" }) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null); const [target, setTarget] = useState(""); useModalFocus(dialog, true, busy, onClose);
  useEffect(() => { const trigger = document.activeElement; return () => { window.requestAnimationFrame(() => { if (!trigger?.isConnected) document.querySelector<HTMLElement>(".carpool-stage-content")?.focus(); }); }; }, []);
  const rider = people.find(person => person.id === riderId); const existing = assignments.find(item => item.riderId === riderId);
  const choices = action === "swap" ? assignments.filter(item => item.riderId !== riderId && item.vehiclePersonId !== existing?.vehiclePersonId && !item.locked).map(item => ({ id: item.riderId, label: `${people.find(person => person.id === item.riderId)?.displayName} in ${people.find(person => person.id === item.vehiclePersonId)?.displayName}'s car`, disabled: false, miles: item.distanceMiles }))
    : people.filter(person => person[`${direction}Status`] === "offer" && person.id !== existing?.vehiclePersonId && person[`${direction}Latitude`] !== null && person[`${direction}Longitude`] !== null).map(person => {
      const open = (person[`${direction}Seats`] ?? 0) - assignments.filter(item => item.vehiclePersonId === person.id).length;
      const miles = rider && rider[`${direction}Latitude`] !== null && rider[`${direction}Longitude`] !== null ? carpoolDistanceMiles({ latitude: rider[`${direction}Latitude`]!, longitude: rider[`${direction}Longitude`]! }, { latitude: person[`${direction}Latitude`]!, longitude: person[`${direction}Longitude`]! }) : null;
      return { id: person.id, label: `${person.displayName} - ${Math.max(0, open)} seats available${miles === null ? "" : ` - ${miles.toFixed(1)} miles`}`, disabled: open <= 0 || miles === null, miles };
    });
  const selected = choices.find(choice => choice.id === target); const canApply = selected && !selected.disabled && !existing?.locked;
  return <div className="dialog-backdrop"><section className="ui-dialog carpool-assignment-dialog ui-form" role="dialog" aria-modal="true" aria-labelledby="carpool-assignment-title" aria-describedby="carpool-assignment-help" tabIndex={-1} ref={dialog}>
    <div className="dialog-heading"><h2 id="carpool-assignment-title">{action === "swap" ? "Swap" : existing ? "Move" : "Assign"} {rider?.displayName}</h2><button className="ui-button" type="button" aria-label="Close assignment editor" disabled={busy} onClick={onClose}>×</button></div>
    <p id="carpool-assignment-help">{direction === "outbound" ? "To event" : "From event"}. Distances are straight-line estimates, not driving distances. Full cars are unavailable for moves; swap with a passenger instead.</p>
    <form onSubmit={event => { event.preventDefault(); if (canApply) void onApply(action === "swap" ? { action: "swap", secondRiderId: target } : { action: "move", vehiclePersonId: target }); }}>
      <label>{action === "swap" ? "Passenger to swap with" : "Destination car"}<select required disabled={busy} value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose {action === "swap" ? "a passenger" : "a car"}</option>{choices.map(choice => <option key={choice.id} value={choice.id} disabled={choice.disabled}>{choice.label}</option>)}</select></label>
      {selected?.miles !== null && selected?.miles !== undefined && selected.miles > maximumMiles && <p className="ui-status" data-tone="warning">This manual placement exceeds the automatic matching limit of {maximumMiles} miles. Review the trip with the driver.</p>}
      {existing?.locked && <p className="ui-status" data-tone="warning">Unlock this assignment before changing it.</p>}
      {!choices.some(choice => !choice.disabled) && <p className="ui-status">No eligible {action === "swap" ? "passengers" : "cars with seats"} are available. Review locations, capacity, and locks.</p>}
      {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
      <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={busy || !canApply}>{busy ? "Saving..." : action === "swap" ? "Swap passengers" : "Save assignment"}</button>{existing && <button className="ui-button" type="button" disabled={busy || existing.locked} onClick={() => void onApply({ action: "unassign" })}>Unassign rider</button>}<button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </section></div>;
}
