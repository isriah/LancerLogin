import { useContext, useEffect, useMemo, useState } from "react";
import { carpoolDirections } from "../../../packages/shared/src/carpool-state";
import { ParticipantDraftContext } from "./carpool-interactions";
import { type Detail, type Direction, type Person, leg, needsLocation, statusLabel, needsReview } from "./carpool-model";

export function CarpoolPeople({ detail, locationsOnly, onEdit, onAdd, onImport }: { detail: Detail; locationsOnly: boolean; onEdit: (id: string) => void; onAdd: () => void; onImport: () => void }) {
  const { drafts } = useContext(ParticipantDraftContext); const [query, setQuery] = useState(""); const [filter, setFilter] = useState("all"); const [page, setPage] = useState(1);
  useEffect(() => { setFilter(locationsOnly ? "locations" : "all"); }, [locationsOnly]); useEffect(() => setPage(1), [query, filter]);
  const directions = carpoolDirections(detail.plan.tripScope ?? "both");
  const needsAttention = (person: Person) => directions.some(trip => needsReview(person, trip) || needsLocation(person, trip) && person[`${trip}LocationSource`] === "no-match" || !needsLocation(person, trip) && leg(person, trip).status === "needs-ride" && !detail.assignments.some(item => item.direction === trip && item.riderId === person.id));
  const shown = useMemo(() => detail.people.filter(person => {
    const search = [person.displayName, person.contact, person.outboundAddress, person.returnAddress, person.notes].join(" ").toLocaleLowerCase();
    if (!search.includes(query.trim().toLocaleLowerCase())) return false;
    if (filter === "drivers") return directions.some(trip => leg(person, trip).status === "offer");
    if (filter === "ride-requests") return directions.some(trip => leg(person, trip).status === "needs-ride");
    if (filter === "unassigned") return directions.some(trip => leg(person, trip).status === "needs-ride" && !detail.assignments.some(item => item.direction === trip && item.riderId === person.id));
    if (filter === "attention") return needsAttention(person);
    if (filter === "locations") return directions.some(trip => ["offer", "needs-ride"].includes(leg(person, trip).status));
    return true;
  }), [detail, query, filter]);
  const pageSize = 25; const pages = Math.max(1, Math.ceil(shown.length / pageSize)); const current = Math.min(page, pages); const people = shown.slice((current - 1) * pageSize, current * pageSize); const byId = new Map(detail.people.map(person => [person.id, person]));
  function tripSummary(person: Person, trip: Direction) {
    if (!directions.includes(trip)) return <span className="carpool-not-planned">Not planned</span>;
    const value = leg(person, trip); const assignment = detail.assignments.find(item => item.riderId === person.id && item.direction === trip); const source = person[`${trip}LocationSource`];
    return <><strong>{statusLabel(value.status)}{value.status === "offer" ? ` - ${value.seats ?? "?"} passenger seats` : ""}</strong>{assignment && <span>Assigned to {byId.get(assignment.vehiclePersonId)?.displayName ?? "Unavailable car"}</span>}{value.status === "needs-ride" && !assignment && !needsLocation(person, trip) && <span className="carpool-match-warning">Unassigned</span>}{["offer", "needs-ride"].includes(value.status) && <small>{needsLocation(person, trip) ? !value.address.trim() ? "Address missing" : source === "no-match" ? "No clear address match" : "Awaiting location lookup" : source === "lookup" ? "Automatically located" : source === "manual" ? "Manual coordinates" : "Saved pin"}</small>}</>;
  }
  return <section className="carpool-people-panel" aria-labelledby="carpool-people-title"><div className="carpool-section-heading"><div><h2 id="carpool-people-title">{locationsOnly ? "Location review" : "People"}</h2><p>{detail.people.length} participants · {detail.people.filter(needsAttention).length} need attention</p></div><div className="module-actions"><button className="ui-button ui-button--primary" type="button" onClick={onAdd}>Add participant</button><button className="ui-button" type="button" onClick={onImport}>Import CSV</button></div></div>
    <div className="ui-card carpool-people-filters"><label>Search participants<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, contact, address, or notes" /></label><label>Show participants<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All participants</option><option value="drivers">Drivers</option><option value="ride-requests">Ride requests</option><option value="unassigned">Unassigned riders</option><option value="attention">Needs attention</option><option value="locations">Locations to review</option></select></label></div>
    {!detail.people.length && <p className="ui-empty">Add a participant or import a CSV to start this plan.</p>}
    <div className="carpool-people-list" role="list" aria-label="Carpool participants">{people.map(person => <article className="ui-card carpool-person-row" role="listitem" key={person.id} data-attention={needsAttention(person)}><div className="carpool-person-identity-summary"><strong>{person.displayName}</strong><small>{person.contact || "No contact saved"}</small>{person.memberId && <small>{person.memberActive === false ? "Archived roster link retained" : "Linked to roster"}</small>}{drafts[person.id] && <span className="ui-status" data-tone="warning">Unsaved edits</span>}</div><div className="carpool-person-trip"><span>To event</span>{tripSummary(person, "outbound")}</div><div className="carpool-person-trip"><span>From event</span>{tripSummary(person, "return")}</div><button className="ui-button" type="button" onClick={() => onEdit(person.id)} aria-label={`Edit ${person.displayName}`}>Edit</button></article>)}</div>
    {detail.people.length > 0 && !shown.length && <p className="ui-empty">No participants match these filters.</p>}
    {shown.length > pageSize && <div className="carpool-list-pagination" aria-label="Participant pages"><span>Page {current} of {pages} · {shown.length} results</span><button className="ui-button" type="button" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous participants</button><button className="ui-button" type="button" disabled={current === pages} onClick={() => setPage(current + 1)}>Next participants</button></div>}
  </section>;
}
