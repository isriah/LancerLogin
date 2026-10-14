import { useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useModalFocus } from "./modal-focus";
import { carpoolDirections, type CarpoolTripScope } from "../../../packages/shared/src/carpool-state";
import { type Person, type PersonDraft, type Member, type Direction, statuses, statusLabel, numberOrNull } from "./carpool-model";
import { CarpoolPinMap } from "./carpool-pin-map";

type Errors = Partial<Record<keyof PersonDraft, string>>;
export function CarpoolParticipantEditor({ person, value, update, members, scope, planId, planRevision, geocodingConfigured, busy, dirty, conflict, error, onSave, onClose, onCancel, onRebase, onUseSaved, onRefresh, onRemove }: {
  person: Person | null; value: PersonDraft; update: (value: PersonDraft) => void; members: Member[]; scope: CarpoolTripScope; planId: string; planRevision: number; geocodingConfigured: boolean; busy: boolean; dirty: boolean; conflict: boolean; error?: string;
  onSave: () => Promise<void>; onClose: () => void; onCancel: () => void; onRebase: () => void; onUseSaved: () => void; onRefresh: () => Promise<void>; onRemove: () => Promise<void>;
}) {
  const dialog = useRef<HTMLElement>(null); const [errors, setErrors] = useState<Errors>({}); const [looking, setLooking] = useState(false); const [lookupNotice, setLookupNotice] = useState(""); const [maps, setMaps] = useState<Partial<Record<Direction, boolean>>>({}); const [removeReview, setRemoveReview] = useState(false);
  useModalFocus(dialog, true, busy || looking, onClose);
  const set = (key: keyof PersonDraft, next: string | boolean) => { update({ ...value, [key]: next }); setErrors(current => ({ ...current, [key]: undefined })); };
  const invalid = (key: keyof PersonDraft) => ({ "aria-invalid": errors[key] ? true as const : undefined, "aria-describedby": errors[key] ? `carpool-person-${key}-error` : undefined });
  const message = (key: keyof PersonDraft) => errors[key] && <p className="carpool-field-error" id={`carpool-person-${key}-error`}>{errors[key]}</p>;
  function validate() {
    const next: Errors = {};
    if (!value.displayName.trim()) next.displayName = "Enter a participant name.";
    else if (value.displayName.trim().length > 150) next.displayName = "Use 150 characters or fewer for the name.";
    if (value.contact.length > 300) next.contact = "Use 300 characters or fewer for contact information.";
    if (value.notes.length > 4000) next.notes = "Use 4,000 characters or fewer for notes.";
    for (const trip of carpoolDirections(scope)) {
      const status = value[`${trip}Status`]; const shared = trip === "return" && value.returnSameAsOutbound; const coordinateTrip = shared ? "outbound" : trip;
      if (["offer", "needs-ride"].includes(status) && !(shared ? value.outboundAddress : value[`${trip}Address`]).trim()) next[`${coordinateTrip}Address`] = "Enter the pickup or drop-off address.";
      if (status === "offer" && (!value[`${trip}Seats`].trim() || !Number.isInteger(Number(value[`${trip}Seats`])) || Number(value[`${trip}Seats`]) < 0 || Number(value[`${trip}Seats`]) > 99)) next[`${trip}Seats`] = "Enter a whole number from 0 to 99.";
      const latitude = value[`${coordinateTrip}Latitude`]; const longitude = value[`${coordinateTrip}Longitude`];
      if (Boolean(latitude.trim()) !== Boolean(longitude.trim())) next[`${coordinateTrip}Latitude`] = "Enter latitude and longitude together, or clear both.";
      if (latitude && (!Number.isFinite(Number(latitude)) || Number(latitude) < -90 || Number(latitude) > 90)) next[`${coordinateTrip}Latitude`] = "Latitude must be between -90 and 90.";
      if (longitude && (!Number.isFinite(Number(longitude)) || Number(longitude) < -180 || Number(longitude) > 180)) next[`${coordinateTrip}Longitude`] = "Longitude must be between -180 and 180.";
    }
    setErrors(next); if (Object.keys(next).length) { requestAnimationFrame(() => { const target = dialog.current?.querySelector<HTMLElement>("[aria-invalid='true']:not([disabled])"); const details = target?.closest("details"); if (details) details.open = true; target?.focus(); }); return false; } return true;
  }
  async function locate(trip: Direction) {
    const key = trip === "return" && value.returnSameAsOutbound ? "outbound" : trip; const address = value[`${key}Address`].trim(); if (!address) { setErrors({ [`${key}Address`]: "Enter an address to locate." }); return; }
    setLooking(true); setLookupNotice("");
    try {
      const found = await api<{ status: "success" | "no-match"; latitude: number | null; longitude: number | null; label: string | null; lookupKey: string }>(`/admin/carpool/plans/${encodeURIComponent(planId)}/locations/lookup`, { method: "POST", body: JSON.stringify({ address, direction: trip, planRevision }) });
      update({ ...value, [`${key}Latitude`]: found.latitude?.toString() ?? "", [`${key}Longitude`]: found.longitude?.toString() ?? "", [`${key}LocationLookupKey`]: found.lookupKey, [`${key}LocationConfirmed`]: true });
      setLookupNotice(found.status === "success" ? `Located ${found.label || address}. Review the pin, then save the participant.` : "No matching address was found. Add city or ZIP details, retry, or place a manual pin."); setMaps(current => ({ ...current, [trip]: found.status === "success" }));
    } catch (caught) { setLookupNotice((caught as Error).message); } finally { setLooking(false); }
  }
  function pin(trip: Direction, latitude: number, longitude: number) { const key = trip === "return" && value.returnSameAsOutbound ? "outbound" : trip; update({ ...value, [`${key}Latitude`]: latitude.toFixed(6), [`${key}Longitude`]: longitude.toFixed(6), [`${key}LocationLookupKey`]: "", [`${key}LocationConfirmed`]: true }); }
  const unavailable = value.memberId && !members.some(member => member.id === value.memberId);
  return <div className="dialog-backdrop"><section className="ui-dialog carpool-person-dialog" role="dialog" aria-modal="true" aria-labelledby="carpool-person-title" tabIndex={-1} ref={dialog}>
    <div className="dialog-heading"><div><h2 id="carpool-person-title">{person ? `Edit ${person.displayName}` : "Add participant"}</h2><p>Form changes stay unsaved until you choose Save. Closing keeps the draft while this plan is open.</p></div><button className="ui-button" type="button" disabled={busy || looking} aria-label="Close participant editor" onClick={onClose}>×</button></div>
    <form className="ui-form" noValidate onSubmit={event => { event.preventDefault(); if (validate() && !conflict) void onSave(); }}>
      <fieldset disabled={busy || looking} className="carpool-person-identity"><legend>Participant</legend><div className="form-grid">
        <div className="carpool-person-field"><label>Name<input required maxLength={150} value={value.displayName} onChange={event => set("displayName", event.target.value)} {...invalid("displayName")} data-modal-initial-focus /></label>{message("displayName")}</div>
        <div className="carpool-person-field"><label>Contact<input maxLength={300} value={value.contact} onChange={event => set("contact", event.target.value)} {...invalid("contact")} aria-describedby={errors.contact ? "carpool-person-contact-error carpool-contact-help" : "carpool-contact-help"} /></label><small id="carpool-contact-help">Email or phone for coordinating this trip.</small>{message("contact")}</div>
        <label>Roster member (optional)<select value={value.memberId} onChange={event => { const member = members.find(member => member.id === event.target.value); update({ ...value, memberId: event.target.value, displayName: member ? `${member.firstName} ${member.lastName}` : value.displayName, contact: member?.email ?? value.contact }); }}><option value="">Ad hoc participant</option>{unavailable && <option value={value.memberId}>Previously linked member - unavailable</option>}{members.map(member => <option key={member.id} value={member.id}>{member.firstName} {member.lastName} - {member.externalId}</option>)}</select></label>
      </div></fieldset>
      <div className="carpool-leg-grid">{(["outbound", "return"] as const).map(trip => {
        const label = trip === "outbound" ? "To event" : "From event"; const planned = carpoolDirections(scope).includes(trip); const shared = trip === "return" && value.returnSameAsOutbound; const key = shared ? "outbound" : trip; const status = value[`${trip}Status`]; const hasLocation = Boolean(value[`${key}Latitude`] && value[`${key}Longitude`]); const source = person?.[`${key}LocationSource`]; const changedPin = value[`${key}LocationConfirmed`] || person && (value[`${key}Address`] !== person[`${key}Address`] || Number(value[`${key}Latitude`]) !== person[`${key}Latitude`] || Number(value[`${key}Longitude`]) !== person[`${key}Longitude`]);
        return <fieldset key={trip} disabled={!planned || busy || looking} className="carpool-person-leg"><legend>{label}{!planned && " - not planned"}</legend>
          {!planned ? <p>This plan does not include this direction. Existing trip details are retained.</p> : <>
          <label>{label} transportation<select value={status} onChange={event => set(`${trip}Status`, event.target.value)}>{statuses.map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
          {status === "unknown" && <p className="ui-status" data-tone="warning">{person?.[`${trip}SourceStatus`] ? `Imported response: "${person[`${trip}SourceStatus`]}". Choose the closest status.` : "Choose a transportation status when it is known."}</p>}
          {status === "offer" && <div className="carpool-person-seat-field"><label>{label} passenger seats<input required type="number" min="0" max="99" step="1" value={value[`${trip}Seats`]} onChange={event => set(`${trip}Seats`, event.target.value)} {...invalid(`${trip}Seats`)} /></label>{message(`${trip}Seats`)}</div>}
          {["offer", "needs-ride"].includes(status) && <>
            {trip === "return" && <label className="checkbox-field"><input className="ui-checkbox" type="checkbox" checked={value.returnSameAsOutbound} onChange={event => set("returnSameAsOutbound", event.target.checked)} /> Use the same pickup/drop-off address</label>}
            <label>{label} {trip === "outbound" ? "pickup" : "drop-off"} address<input required disabled={shared && scope !== "return" && ["offer", "needs-ride"].includes(value.outboundStatus)} maxLength={500} value={value[`${key}Address`]} onChange={event => set(`${key}Address`, event.target.value)} {...invalid(`${key}Address`)} /></label>{message(`${key}Address`)}
            <p className="ui-status" data-tone={hasLocation ? undefined : "warning"}>{hasLocation ? value[`${key}LocationLookupKey`] ? "Located pin in this draft" : source === "lookup" && !changedPin ? `Automatically located${person?.[`${key}LocationLabel`] ? `: ${person[`${key}LocationLabel`]}` : ""}` : source === "manual" || changedPin ? "Manual coordinates" : "Saved pin" : source === "no-match" && !changedPin ? "No matching address found" : "Location needs review"}</p>
            <div className="module-actions"><button className="ui-button" type="button" disabled={!geocodingConfigured || !value[`${key}Address`].trim()} onClick={() => void locate(trip)}>{looking ? "Locating..." : `Locate ${label.toLowerCase()} address`}</button><button className="ui-button" type="button" aria-expanded={Boolean(maps[trip])} onClick={() => setMaps(current => ({ ...current, [trip]: !current[trip] }))}>Review or place {label.toLowerCase()} pin</button></div>
            {!geocodingConfigured && <p className="carpool-location-help">Automatic lookup is unavailable. Place a pin on the map or enter coordinates below.</p>}
            {maps[trip] && <CarpoolPinMap label={label} latitude={numberOrNull(value[`${key}Latitude`])} longitude={numberOrNull(value[`${key}Longitude`])} onChange={(latitude, longitude) => pin(trip, latitude, longitude)} />}
            <details className="carpool-coordinate-details"><summary>{label} advanced coordinates</summary><div className="form-grid"><div className="carpool-person-field"><label>{label} latitude<input type="number" min="-90" max="90" step="any" value={value[`${key}Latitude`]} onChange={event => set(`${key}Latitude`, event.target.value)} {...invalid(`${key}Latitude`)} /></label>{message(`${key}Latitude`)}</div><div className="carpool-person-field"><label>{label} longitude<input type="number" min="-180" max="180" step="any" value={value[`${key}Longitude`]} onChange={event => set(`${key}Longitude`, event.target.value)} {...invalid(`${key}Longitude`)} /></label>{message(`${key}Longitude`)}</div></div></details>
          </>}
          </>}
        </fieldset>;
      })}</div>
      <div className="carpool-person-field"><label htmlFor="carpool-person-notes">Notes</label><textarea id="carpool-person-notes" maxLength={4000} disabled={busy || looking} value={value.notes} onChange={event => set("notes", event.target.value)} {...invalid("notes")} />{message("notes")}</div>
      {lookupNotice && <p className="ui-status" role="status">{lookupNotice}</p>}
      {conflict && person && <section className="ui-card carpool-conflict"><h3>Saved details changed</h3><p>Latest saved name: {person.displayName}; contact: {person.contact || "None"}.</p>{(["outbound", "return"] as const).map(trip => <p key={trip}>{trip === "outbound" ? "To event" : "From event"}: {statusLabel(person[`${trip}Status`])}; address: {person[`${trip}Address`] || "None"}; passenger seats: {person[`${trip}Seats`] ?? "None"}.</p>)}<div className="module-actions"><button className="ui-button" type="button" onClick={onUseSaved}>Use saved values</button><button className="ui-button" type="button" onClick={onRebase}>Keep my edits after review</button></div></section>}
      {error && <div className="ui-status" data-tone="error" role="alert"><p>{error}</p><button className="ui-button" type="button" disabled={busy || looking} onClick={() => void onRefresh()}>Refresh saved plan</button></div>}
      <div className="module-actions"><button className="ui-button ui-button--primary" type="submit" disabled={busy || looking || conflict || person !== null && !dirty}>{busy ? "Saving..." : person ? "Save participant" : "Add participant"}</button><button className="ui-button" type="button" disabled={busy || looking} onClick={onCancel}>Cancel changes</button></div>
      {person && <details className="carpool-person-more"><summary>More participant actions</summary>{removeReview ? <><p>Remove {person.displayName} and their assignments from this plan?</p><div className="module-actions"><button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => void onRemove()}>Confirm remove participant</button><button className="ui-button" type="button" onClick={() => setRemoveReview(false)}>Keep participant</button></div></> : <button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => setRemoveReview(true)}>Remove participant</button>}</details>}
    </form>
  </section></div>;
}
