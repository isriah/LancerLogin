import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import type { LabelData } from "./member-labels";
import type { RosterMember } from "./user-settings";

type Action = "deactivate" | "reactivate" | "add" | "remove";
type Preview = { previewToken: string; changed?: number; members?: { memberId: string; name: string; active: boolean; willChange: boolean }[]; changes?: { memberId: string; label: string; action: "add" | "remove"; effectiveDate: string }[]; impact?: { memberId: string; beforeRate: number | null; afterRate: number | null; affectedCompletedMeetings: number }[] };

export function BulkRosterActions({ selected, shown, selectedIds, onSelectionChange, labels, onApplied }: { selected: RosterMember[]; shown: RosterMember[]; selectedIds: string[]; onSelectionChange: (ids: string[]) => void; labels?: LabelData; onApplied: () => Promise<void> }) {
  const [action, setAction] = useState<Action>("add");
  const [labelId, setLabelId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const selectionKey = selected.map((member) => member.id).join(":");
  useEffect(() => { setPreview(undefined); }, [selectionKey, action, labelId, effectiveDate]);
  const labelAction = action === "add" || action === "remove";
  const label = labels?.labels.find((item) => item.id === labelId);
  const active = action === "reactivate";
  async function prepare() {
    if (!selected.length || labelAction && !label) return;
    setBusy(true); setNotice("");
    try {
      if (labelAction) {
        const changes = selected.map((member) => ({ memberId: member.memberId, label: label!.name, action, effectiveDate }));
        setPreview(await api<Preview>("/labels/membership/preview", { method: "POST", body: JSON.stringify({ changes }) }));
      } else setPreview(await api<Preview>("/admin/members/bulk/preview", { method: "POST", body: JSON.stringify({ memberIds: selected.map((member) => member.id), active }) }));
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true); setNotice("");
    try {
      if (preview.changes) await api("/labels/membership/apply", { method: "POST", body: JSON.stringify({ changes: preview.changes, previewToken: preview.previewToken }) });
      else await api("/admin/members/bulk/apply", { method: "POST", body: JSON.stringify({ memberIds: selected.map((member) => member.id), active, previewToken: preview.previewToken }) });
      setPreview(undefined); await onApplied(); setNotice(`${selected.length} selected member records processed.`);
    } catch (error) { setPreview(undefined); setNotice((error as Error).message); } finally { setBusy(false); }
  }
  return <section className="bulk-roster-actions ui-card" aria-labelledby="bulk-roster-title"><h3 id="bulk-roster-title">Bulk edit</h3><p>{selected.length} members selected. Select an action, preview its effect, then apply it.</p><label className="checkbox-field bulk-select-all"><input type="checkbox" aria-label="Select all shown members" disabled={busy} checked={shown.length > 0 && shown.every((member) => selectedIds.includes(member.id))} onChange={(event) => onSelectionChange(event.target.checked ? shown.map((member) => member.id) : [])} />Select all {shown.length} shown members</label><div className="bulk-roster-fields"><label>Action<select value={action} onChange={(event) => setAction(event.target.value as Action)}><option value="add">Add label</option><option value="remove">Remove label</option><option value="deactivate">Deactivate members</option><option value="reactivate">Reactivate members</option></select></label>{labelAction && <><label>Label<select value={labelId} onChange={(event) => setLabelId(event.target.value)}><option value="">Choose label</option>{labels?.labels.filter((item) => action === "remove" || item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Effective date <span>(optional)</span><input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /><small>Blank uses today in the organization time zone.</small></label></>}</div>{notice && <p className="ui-status" role="status">{notice}</p>}<button className="ui-button ui-button--primary" type="button" disabled={busy || !selected.length || labelAction && !label} onClick={() => void prepare()}>Preview bulk change</button>{preview && <div className="bulk-roster-preview" role="region" aria-label="Bulk change preview"><p>{preview.changes ? `${preview.changes.length} dated label changes` : `${preview.changed} members will change roster status`}. Review before applying.</p>{preview.changes ? <ul className="compact-list">{preview.changes.map((item) => <li key={item.memberId}>{item.memberId}: {item.action} {item.label} on {item.effectiveDate}</li>)}</ul> : <ul className="compact-list">{preview.members?.map((member) => <li key={member.memberId}>{member.name} ({member.memberId}): {member.willChange ? active ? "reactivate" : "deactivate" : "already in requested state"}</li>)}</ul>}{preview.impact && <p>Attendance impact: {preview.impact.filter((item) => item.affectedCompletedMeetings).length} member records have changed meeting eligibility.</p>}<div className="dialog-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => setPreview(undefined)}>Back</button><button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void apply()}>Apply bulk change</button></div></div>}</section>;
}
