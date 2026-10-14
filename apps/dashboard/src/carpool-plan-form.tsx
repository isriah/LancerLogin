import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CarpoolMeetingSelector, type RelatedMeeting } from "./carpool-meeting-links";
import { changePlanTimeZone, planPayload, type PlanDraft } from "./carpool-model";
import { resolveCivilTime, type CivilTimeOccurrence } from "../../../packages/shared/src/civil-time";

export function PlanForm({ heading, value, update, busy, submitLabel, onSubmit, onCancel, extra, meetingChoices, meetingReferencesAvailable }: {
  heading: string; value: PlanDraft; update: (value: PlanDraft) => void; busy: boolean; submitLabel: string; onSubmit: (event: FormEvent) => void; onCancel: () => void; extra?: ReactNode; meetingChoices: RelatedMeeting[]; meetingReferencesAvailable: boolean;
}) {
  const notesId = useId(); const [error, setError] = useState(""); const errorElement = useRef<HTMLParagraphElement>(null);
  const zones = [...new Set([value.timeZone, "UTC", ...Intl.supportedValuesOf("timeZone")])];
  return <form className="ui-card ui-form carpool-create" onSubmit={event => { try { planPayload(value); setError(""); onSubmit(event); } catch (caught) { event.preventDefault(); setError((caught as Error).message); requestAnimationFrame(() => errorElement.current?.focus()); } }}>
    <h2>{heading}</h2>
    <div className="form-grid">
      <label>Event name<input disabled={busy} required maxLength={150} value={value.title} onChange={event => update({ ...value, title: event.target.value })} /></label>
      <label>Event destination<input disabled={busy} maxLength={300} value={value.destination} onChange={event => update({ ...value, destination: event.target.value })} placeholder="Venue name and address" /></label>
      <label>Planned trips<select disabled={busy} value={value.tripScope} onChange={event => update({ ...value, tripScope: event.target.value as PlanDraft["tripScope"] })}><option value="both">To and from event</option><option value="outbound">To event only</option><option value="return">From event only</option></select></label>
      <CarpoolMeetingSelector meetingId={value.meetingId} choices={meetingChoices} available={meetingReferencesAvailable} busy={busy} onChange={meetingId => update({ ...value, meetingId })} />
      <label>Trip time zone<select value={value.timeZone} disabled={busy} onChange={event => { try { update(changePlanTimeZone(value, event.target.value)); setError(""); } catch (caught) { setError((caught as Error).message); } }}>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select><small>All event and trip times use this zone. Changing it preserves the instant.</small></label>
      {value.tripScope !== "return" && <ScheduleTimeField label="To-event departure" value={value.outboundDepartureAt} occurrence={value.outboundOccurrence} zone={value.timeZone} busy={busy} onChange={(local, occurrence) => update({ ...value, outboundDepartureAt: local, outboundOccurrence: occurrence })} />}
      {value.tripScope !== "outbound" && <ScheduleTimeField label="From-event departure" value={value.returnDepartureAt} occurrence={value.returnOccurrence} zone={value.timeZone} busy={busy} onChange={(local, occurrence) => update({ ...value, returnDepartureAt: local, returnOccurrence: occurrence })} />}
      <ScheduleTimeField label="Event starts" value={value.eventStartsAtSnapshot} occurrence={value.eventOccurrence} zone={value.timeZone} busy={busy} onChange={(local, occurrence) => update({ ...value, eventStartsAtSnapshot: local, eventOccurrence: occurrence })} />
    </div>
    <div className="ui-form"><label htmlFor={notesId}>Notes</label><textarea id={notesId} disabled={busy} maxLength={4000} value={value.notes} onChange={event => update({ ...value, notes: event.target.value })} /></div>
    <details className="carpool-plan-advanced"><summary>Advanced event details</summary><div className="form-grid">
      <label>External event reference <span>(optional)</span><input disabled={busy} maxLength={200} value={value.eventReference} onChange={event => update({ ...value, eventReference: event.target.value })} /></label>
      <label>Related event title <span>(optional)</span><input disabled={busy} maxLength={150} value={value.eventTitleSnapshot} onChange={event => update({ ...value, eventTitleSnapshot: event.target.value })} /></label>
      <label>Maximum radius (miles)<input disabled={busy} required type="number" min="0.5" max="250" step="0.5" value={value.radiusMiles} onChange={event => update({ ...value, radiusMiles: event.target.value })} /></label>
      <label>Preferred radius (miles)<input disabled={busy} required type="number" min="0.5" max={value.radiusMiles} step="0.5" value={value.preferredRadiusMiles} onChange={event => update({ ...value, preferredRadiusMiles: event.target.value })} /></label>
    </div></details>
    {error && <p className="ui-status" data-tone="error" role="alert" tabIndex={-1} ref={errorElement}>{error}</p>}
    <div className="module-actions"><button className="ui-button ui-button--primary" disabled={busy} type="submit">{submitLabel}</button><button className="ui-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
    {extra}
  </form>;
}

function ScheduleTimeField({ label, value, occurrence, zone, busy, onChange }: { label: string; value: string; occurrence: "" | CivilTimeOccurrence; zone: string; busy: boolean; onChange: (value: string, occurrence: "" | CivilTimeOccurrence) => void }) {
  let ambiguous = false; let error = "";
  if (value) try { const [date, time] = value.split("T"); const candidates = resolveCivilTime({ date, time, timeZone: zone }); ambiguous = candidates.length > 1; if (!candidates.length) error = "This time does not exist because the clock changes. Choose another time."; } catch (caught) { error = (caught as Error).message; }
  const id = "carpool-time-" + label.toLowerCase().replaceAll(" ", "-");
  return <div className="ui-form"><label>{label} <span>(optional)</span><input type="datetime-local" step="any" value={value} disabled={busy} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? id : undefined} onChange={event => onChange(event.target.value, "")} /></label>{error && <small id={id} className="carpool-field-error">{error}</small>}{ambiguous && <label>{label} clock occurrence<select required value={occurrence} disabled={busy} onChange={event => onChange(value, event.target.value as CivilTimeOccurrence)}><option value="">Choose which occurrence</option><option value="earlier">Earlier occurrence, before the clock moves back</option><option value="later">Later occurrence, after the clock moves back</option></select></label>}</div>;
}
