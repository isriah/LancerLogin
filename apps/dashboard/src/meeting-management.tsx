import { FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useModalFocus } from "./modal-focus";

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly";
export type Meeting = { id: string; title: string; startsAt: string; endsAt: string; attendanceClosesAt: string; required: boolean | number; notes?: string | null; isTest?: boolean | number; seriesId?: string | null; recurrenceFrequency?: Frequency | null; recurrenceUntil?: string | null; recurrenceSequence?: number | null };
export type MeetingForm = { title: string; date: string; startTime: string; endTime: string; required: boolean; notes: string };
export type PendingMeetingDeletion = { meetingId: string; title: string; scope: "occurrence" | "future" };

export const pendingMeetingDeletionKey = "lancerlogin-pending-meeting-deletion";
export const localInput = (value: string) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
export const splitLocal = (value: string) => { const local = localInput(value); return { date: local.slice(0, 10), time: local.slice(11, 16) }; };
export const addMinutes = (date: string, time: string, minutes: number) => {
  const next = new Date(`${date}T${time || "00:00"}`);
  next.setMinutes(next.getMinutes() + minutes);
  const local = localInput(next.toISOString());
  return local.slice(0, 10) === date ? local.slice(11, 16) : "23:59";
};
export const meetingTimestamps = (value: MeetingForm) => ({ startsAt: new Date(`${value.date}T${value.startTime}`).toISOString(), endsAt: new Date(`${value.date}T${value.endTime}`).toISOString() });
export const initialMeetingForm = (): MeetingForm => { const start = splitLocal(new Date(Date.now() + 3_600_000).toISOString()); return { title: "", date: start.date, startTime: start.time, endTime: addMinutes(start.date, start.time, 150), required: true, notes: "" }; };
export const frequencyLabel = (value?: Frequency | null) => value === "biweekly" ? "Every two weeks" : value ? `${value[0].toUpperCase()}${value.slice(1)}` : "One time";
export const dateAfterDays = (date: string, days: number) => { const next = new Date(`${date}T12:00:00`); next.setDate(next.getDate() + days); return localInput(next.toISOString()).slice(0, 10); };

export function formForMeeting(meeting: Meeting, duplicate = false): MeetingForm {
  const start = splitLocal(meeting.startsAt); const end = splitLocal(meeting.endsAt);
  if (!duplicate) return { title: meeting.title, date: start.date, startTime: start.time, endTime: end.time, required: Boolean(meeting.required), notes: meeting.notes ?? "" };
  const base = initialMeetingForm();
  return { title: meeting.title, date: base.date, startTime: start.time, endTime: addMinutes(base.date, start.time, (Date.parse(meeting.endsAt) - Date.parse(meeting.startsAt)) / 60_000), required: Boolean(meeting.required), notes: meeting.notes ?? "" };
}

export function MeetingFields({ value, onChange, initialFocus = false }: { value: MeetingForm; onChange: (value: MeetingForm) => void; initialFocus?: boolean }) {
  const changeStart = (startTime: string) => onChange({ ...value, startTime, endTime: addMinutes(value.date, startTime, 150) });
  const changeDate = (date: string) => onChange({ ...value, date, endTime: addMinutes(date, value.startTime, 150) });
  return <>
    <label>Title<input data-modal-initial-focus={initialFocus ? "true" : undefined} required maxLength={120} value={value.title} onChange={(event) => onChange({ ...value, title: event.target.value })} /></label>
    <div className="form-grid"><label>Date<input required type="date" value={value.date} onChange={(event) => changeDate(event.target.value)} /></label><label>Start time<input required type="time" value={value.startTime} onChange={(event) => changeStart(event.target.value)} /></label><label>End time<input required type="time" value={value.endTime} onChange={(event) => onChange({ ...value, endTime: event.target.value })} /></label></div>
    <label>Notes <span>(optional)</span><textarea rows={4} maxLength={2000} value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} /></label>
    <div className="inline-options"><label><input type="checkbox" checked={value.required} onChange={(event) => onChange({ ...value, required: event.target.checked })} /> Attendance required</label></div>
  </>;
}

function ManagementDialog({ titleId, title, description, busy, onClose, children }: { titleId: string; title: string; description: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(dialog, true, busy, onClose);
  const descriptionId = `${titleId}-description`;
  return <div className="dialog-backdrop"><section ref={dialog} className="meeting-management-dialog ui-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1}>
    <div className="dialog-heading"><div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div><button type="button" aria-label={`Close ${title.toLocaleLowerCase()}`} disabled={busy} onClick={onClose}>×</button></div>
    {children}
  </section></div>;
}

export function MeetingEditDialog({ meeting, onClose, onSaved }: { meeting: Meeting; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [form, setForm] = useState(() => formForMeeting(meeting)); const [scope, setScope] = useState<"occurrence" | "future">("occurrence"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const errorAlert = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorAlert.current?.focus(); }, [error]);
  async function save(event: FormEvent) { event.preventDefault(); setError(""); setBusy(true); try { const body = { ...form, meetingId: meeting.id, ...meetingTimestamps(form) }; if (scope === "future" && meeting.seriesId) await api(`/meeting-series/${encodeURIComponent(meeting.seriesId)}`, { method: "PATCH", body: JSON.stringify(body) }); else await api(`/meetings/${encodeURIComponent(meeting.id)}`, { method: "PATCH", body: JSON.stringify(body) }); await onSaved(scope === "future" ? "This and future series occurrences were updated." : "Meeting occurrence updated."); onClose(); } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); } }
  return <ManagementDialog titleId="edit-meeting-title" title="Edit meeting" description={meeting.seriesId ? "Update this occurrence or apply the change to the rest of its series." : "Update this meeting."} busy={busy} onClose={onClose}><form className="meeting-edit-form" onSubmit={save}><MeetingFields value={form} onChange={setForm} initialFocus />{meeting.seriesId && <fieldset><legend>Apply changes to</legend><div className="inline-options"><label><input type="radio" name="edit-scope" checked={scope === "occurrence"} onChange={() => setScope("occurrence")} /> This occurrence only</label><label><input type="radio" name="edit-scope" checked={scope === "future"} onChange={() => setScope("future")} /> This and future occurrences</label></div></fieldset>}{error && <p ref={errorAlert} className="inline-messages error" role="alert" tabIndex={-1}>{error}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save meeting"}</button></div></form></ManagementDialog>;
}

export function MeetingDuplicateDialog({ meeting, onClose, onCreated }: { meeting: Meeting; onClose: () => void; onCreated: (message: string) => Promise<void> }) {
  const baseDate = initialMeetingForm().date; const [form, setForm] = useState(() => formForMeeting(meeting, true)); const [frequency, setFrequency] = useState<"once" | Frequency>(meeting.recurrenceFrequency ?? "once"); const [seriesUntil, setSeriesUntil] = useState(() => meeting.recurrenceFrequency && meeting.recurrenceUntil ? dateAfterDays(baseDate, Math.max(1, Math.round((Date.parse(meeting.recurrenceUntil) - Date.parse(meeting.startsAt)) / 86_400_000))) : ""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const errorAlert = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorAlert.current?.focus(); }, [error]);
  async function create(event: FormEvent) { event.preventDefault(); setError(""); setBusy(true); try { const recurrence = frequency === "once" ? undefined : { frequency, until: new Date(`${seriesUntil}T23:59:59`).toISOString() }; const result = await api<{ meetings: unknown[] }>("/meetings", { method: "POST", body: JSON.stringify({ ...form, ...meetingTimestamps(form), recurrence }) }); await onCreated(`${result.meetings.length} ${result.meetings.length === 1 ? "meeting" : "meetings"} duplicated.`); onClose(); } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); } }
  return <ManagementDialog titleId="duplicate-meeting-title" title="Duplicate meeting" description={`Start a new meeting or series from ${meeting.title}.`} busy={busy} onClose={onClose}><form className="meeting-create-form" onSubmit={create}><MeetingFields value={form} onChange={setForm} initialFocus /><div className="form-grid"><label>Frequency<select value={frequency} onChange={(event) => setFrequency(event.target.value as "once" | Frequency)}><option value="once">One time</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option></select></label>{frequency !== "once" && <label>Series end date<input required type="date" value={seriesUntil} min={form.date} onChange={(event) => setSeriesUntil(event.target.value)} /></label>}</div>{error && <p ref={errorAlert} className="inline-messages error" role="alert" tabIndex={-1}>{error}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? "Duplicating…" : frequency === "once" ? "Duplicate meeting" : "Duplicate recurring series"}</button></div></form></ManagementDialog>;
}

export function MeetingDeleteDialog({ meeting, meetings, onClose, onDeleted }: { meeting: Meeting; meetings: Meeting[]; onClose: () => void; onDeleted: (deletion: PendingMeetingDeletion) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const errorAlert = useRef<HTMLParagraphElement>(null); const future = meeting.seriesId ? meetings.filter((item) => item.seriesId === meeting.seriesId && Date.parse(item.startsAt) >= Date.parse(meeting.startsAt)) : [];
  useEffect(() => { if (error) errorAlert.current?.focus(); }, [error]);
  async function remove(scope: "occurrence" | "future") { setError(""); setBusy(true); try { await api(`/meetings/${encodeURIComponent(meeting.id)}`, { method: "DELETE", body: JSON.stringify({ scope }) }); onDeleted({ meetingId: meeting.id, title: meeting.title, scope }); } catch (caught) { setError((caught as Error).message); setBusy(false); } }
  return <ManagementDialog titleId="delete-meeting-title" title="Delete meeting" description={meeting.seriesId ? "Choose what to delete from this recurring series." : "Attendance history is retained for audit."} busy={busy} onClose={onClose}>{meeting.seriesId && <ul className="future-meeting-list">{future.map((item) => <li key={item.id}>{new Date(item.startsAt).toLocaleDateString()} · {item.title}</li>)}</ul>}{error && <p ref={errorAlert} className="inline-messages error" role="alert" tabIndex={-1}>{error}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="danger-button" type="button" disabled={busy} onClick={() => void remove("occurrence")}>{busy ? "Deleting…" : "Delete this meeting"}</button>{meeting.seriesId && <button className="danger-button" type="button" disabled={busy} onClick={() => void remove("future")}>Delete this and future meetings</button>}</div></ManagementDialog>;
}
