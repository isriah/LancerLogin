import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { DiscordSyncReminder } from "./labels-page";
import { linkedLabelNames } from "./member-label-controls";
import type { LabelData } from "./member-labels";
import { useModalFocus } from "./modal-focus";
import { attendanceRateText } from "./report-attendance";
import type { RosterMember } from "./user-settings";

type Action = "deactivate" | "reactivate" | "add" | "remove";
type Preview = { previewToken: string; changed?: number; members?: { memberId: string; name: string; active: boolean; willChange: boolean }[]; changes?: { memberId: string; label: string; action: "add" | "remove"; effectiveDate: string }[]; impact?: { memberId: string; beforeRate: number | null; afterRate: number | null; affectedCompletedMeetings: number }[] };

const count = (value: number) => `${value} member${value === 1 ? "" : "s"}`;
const dateText = (value: string) => value ? new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "today";

/** Header checkbox for the roster table. Filter changes clear the selection, so it always covers shown members only. */
export function SelectAllShown({ shown, selectedIds, onSelectionChange }: { shown: RosterMember[]; selectedIds: string[]; onSelectionChange: (ids: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const shownIds = shown.map((member) => member.id);
  const selectedShown = shownIds.filter((id) => selectedIds.includes(id)).length;
  const all = shownIds.length > 0 && selectedShown === shownIds.length;
  useEffect(() => { if (input.current) input.current.indeterminate = selectedShown > 0 && !all; }, [selectedShown, all]);
  return <label className="checkbox-field bulk-select-label bulk-select-all"><input ref={input} className="ui-checkbox" type="checkbox" aria-label="Select all shown members" disabled={!shownIds.length} checked={all} onChange={() => onSelectionChange(all ? [] : shownIds)} /><span className="bulk-select-all-text" aria-hidden="true">Select all {shownIds.length} shown</span></label>;
}

/** Right-hand sidebar (a bottom bar with a slide-up panel on phones) that previews one change for every selected member in a review dialog. */
export function BulkRosterActions({ selected, showingInactive, labels, onClear, onShowInactive, onApplied }: { selected: RosterMember[]; showingInactive: boolean; labels?: LabelData; onClear: () => void; onShowInactive: () => void; onApplied: (message: string) => Promise<void> }) {
  const [action, setAction] = useState<Action>("add");
  const [labelId, setLabelId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [dateOpen, setDateOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linked, setLinked] = useState<string[]>([]);
  const dialog = useRef<HTMLDivElement>(null);
  const selectionKey = selected.map((member) => member.id).join(":");
  useEffect(() => { setPreview(undefined); setError(""); }, [selectionKey, action, labelId, effectiveDate]);
  useEffect(() => { if (!selected.length) setSheetOpen(false); }, [selected.length]);
  useModalFocus(dialog, Boolean(preview), busy, () => setPreview(undefined));
  const labelAction = action === "add" || action === "remove";
  const label = labels?.labels.find((item) => item.id === labelId);
  const active = action === "reactivate";
  const blocked = labelAction && !label ? "Choose a label to preview." : "";
  async function prepare() {
    if (!selected.length || blocked) return;
    setBusy(true); setError(""); setLinked([]);
    try {
      if (labelAction) {
        const changes = selected.map((member) => ({ memberId: member.memberId, label: label!.name, action, effectiveDate }));
        setPreview(await api<Preview>("/labels/membership/preview", { method: "POST", body: JSON.stringify({ changes }) }));
      } else setPreview(await api<Preview>("/admin/members/bulk/preview", { method: "POST", body: JSON.stringify({ memberIds: selected.map((member) => member.id), active }) }));
    } catch (caught) { setError((caught as Error).message); } finally { setBusy(false); }
  }
  const changing = preview ? preview.changes ? preview.changes.length : preview.changed ?? 0 : 0;
  async function apply() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      if (preview.changes) await api("/labels/membership/apply", { method: "POST", body: JSON.stringify({ changes: preview.changes, previewToken: preview.previewToken }) });
      else await api("/admin/members/bulk/apply", { method: "POST", body: JSON.stringify({ memberIds: selected.map((member) => member.id), active, previewToken: preview.previewToken }) });
      const message = labelAction ? `${label!.name} ${action === "add" ? "added to" : "removed from"} ${count(changing)}.` : `${count(changing)} ${active ? "reactivated" : "deactivated"}.`;
      setPreview(undefined); setLinked(preview.changes ? linkedLabelNames(preview.changes, labels) : []); await onApplied(message);
    } catch (caught) { setPreview(undefined); setError((caught as Error).message); } finally { setBusy(false); }
  }
  const names = new Map(selected.map((member) => [member.memberId, `${member.firstName} ${member.lastName}`]));
  const changedIds = new Set(preview?.changes?.map((item) => item.memberId));
  const sentence = !preview ? "" : preview.changes ? `${action === "add" ? "Add" : "Remove"} ${label?.name} ${action === "add" ? "to" : "from"} ${count(changing)}, effective ${dateText(preview.changes[0]?.effectiveDate ?? effectiveDate)}.` : `${active ? "Reactivate" : "Deactivate"} ${count(changing)}.`;
  const impact = preview?.impact?.filter((item) => item.affectedCompletedMeetings) ?? [];
  return <aside className="bulk-roster-sidebar" aria-label="Bulk edit" data-sheet-open={sheetOpen ? "true" : undefined} data-previewing={preview ? "true" : undefined}>
    <DiscordSyncReminder labels={linked} />
    {!selected.length ? <p className="bulk-roster-empty">Tick members in the list to edit them together.</p> : <>
      <div className="bulk-roster-summary"><strong>{selected.length} selected</strong><button className="bulk-roster-link" type="button" disabled={busy} onClick={onClear}>Clear</button><button className="ui-button bulk-roster-sheet-toggle" type="button" aria-expanded={sheetOpen} aria-controls="bulk-roster-fields" onClick={() => setSheetOpen((open) => !open)}>{sheetOpen ? "Done" : "Edit"}</button></div>
      <div className="bulk-roster-fields" id="bulk-roster-fields">
        <label>Action<select value={action} disabled={busy} onChange={(event) => setAction(event.target.value as Action)}><option value="add">Add label</option><option value="remove">Remove label</option><option value="deactivate">Deactivate members</option><option value="reactivate">Reactivate members</option></select></label>
        {labelAction && <label>Label<select value={labelId} disabled={busy} onChange={(event) => setLabelId(event.target.value)}><option value="">Choose label</option>{labels?.labels.filter((item) => action === "remove" || item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {labelAction && (dateOpen ? <><label>Effective date<input type="date" value={effectiveDate} disabled={busy} aria-describedby="bulk-roster-date-help" onChange={(event) => setEffectiveDate(event.target.value)} /></label><small className="bulk-roster-date-help" id="bulk-roster-date-help">Leave blank to start today.</small></> : <p className="bulk-roster-date">Starts {dateText(effectiveDate)} · <button className="bulk-roster-link" type="button" disabled={busy} aria-label="Change effective date" onClick={() => setDateOpen(true)}>Change</button></p>)}
        {action === "reactivate" && !showingInactive && <div className="ui-status bulk-roster-notice" data-tone="warning" role="status"><span>Inactive members are hidden while Show is set to Active members.</span><button className="ui-button" type="button" disabled={busy} onClick={onShowInactive}>Show all members</button></div>}
        <button className="ui-button ui-button--primary bulk-roster-preview-button" type="button" aria-describedby={blocked ? "bulk-roster-blocked" : undefined} disabled={busy || Boolean(blocked)} onClick={() => void prepare()}>{busy && !preview ? "Preparing…" : "Preview"}</button>
        {blocked && <small className="bulk-roster-blocked" id="bulk-roster-blocked">{blocked}</small>}
        {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
      </div>
    </>}
    {preview && <div className="dialog-backdrop"><div className="member-dialog bulk-review-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-review-title" tabIndex={-1} ref={dialog}>
      <div className="dialog-heading"><div><h2 id="bulk-review-title">Review bulk change</h2></div><button type="button" aria-label="Close bulk change review" disabled={busy} onClick={() => setPreview(undefined)}>×</button></div>
      <div className="bulk-roster-preview" role="region" aria-label="Bulk change preview">
        <p className="bulk-roster-preview-summary">{sentence}</p>
        <ul className="bulk-roster-preview-list">{preview.changes ? selected.map((member) => <li key={member.id} data-unchanged={changedIds.has(member.memberId) ? undefined : "true"}><span>{member.firstName} {member.lastName} <code>{member.memberId}</code></span><span>{changedIds.has(member.memberId) ? action === "add" ? "Will be added" : "Will be removed" : "No change"}</span></li>) : preview.members?.map((member) => <li key={member.memberId} data-unchanged={member.willChange ? undefined : "true"}><span>{member.name} <code>{member.memberId}</code></span><span>{member.willChange ? active ? "Will be reactivated" : "Will be deactivated" : `No change, already ${member.active ? "active" : "inactive"}`}</span></li>)}</ul>
        {impact.length > 0 && <div className="bulk-roster-impact"><h3>Attendance impact</h3><ul className="bulk-roster-preview-list">{impact.map((item) => <li key={item.memberId}><span>{names.get(item.memberId) ?? item.memberId}</span><span>Regular {attendanceRateText(item.beforeRate)} → {attendanceRateText(item.afterRate)} · {item.affectedCompletedMeetings} meeting{item.affectedCompletedMeetings === 1 ? "" : "s"}</span></li>)}</ul></div>}
        <div className="dialog-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => setPreview(undefined)}>Back</button><button className="ui-button ui-button--primary" type="button" disabled={busy || !changing} onClick={() => void apply()}>{busy ? "Applying…" : changing ? `Apply to ${count(changing)}` : "Nothing to change"}</button></div>
      </div>
    </div></div>}
  </aside>;
}
