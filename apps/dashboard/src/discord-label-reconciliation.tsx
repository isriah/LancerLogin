import { useState } from "react";
import "./discord-label-two-way.css";

export type ReconciliationChoice = "dashboard" | "discord";
export type ReconciliationMismatch = { memberId: string; name: string; discordUserId: string; displayName: string; hasLabel: boolean; hasRole: boolean };
export type ReconciliationAttendance = { affectsAttendance: boolean; attendanceRules: number; weeklyTargets: number; meetingAudiences: number };
/** The API's two-way sync review: POST /admin/integrations/discord/label-roles/two-way/preview. */
export type ReconciliationPreview = { previewId: string; expiresAt: string; labelId: string; labelName: string; roleId: string; roleName: string; pairedCount: number; mismatches: ReconciliationMismatch[]; unmatchedCount: number; attendance: ReconciliationAttendance };
/** The body for POST /admin/integrations/discord/label-roles/two-way/confirm. */
export type ReconciliationConfirmInput = { previewId: string; choices: Record<string, ReconciliationChoice>; acknowledgeAttendance: boolean };
export type DiscordLabelReconciliationProps = {
  preview: ReconciliationPreview;
  /** Applies the choices and turns on two-way sync. A rejection is shown in the card; the label stays Dashboard to Discord. */
  onConfirm: (input: ReconciliationConfirmInput) => Promise<void>;
  /** Closes the card. Before confirming, the label stays Dashboard to Discord. */
  onCancel: () => void;
  busy?: boolean;
};

const count = (value: number, one: string, many = `${one}s`) => `${value} ${value === 1 ? one : many}`;
const list = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

function SideControl({ label, value, onChange, dashboard = "Dashboard", discord = "Discord" }: { label: string; value?: ReconciliationChoice; onChange: (choice: ReconciliationChoice) => void; dashboard?: string; discord?: string }) {
  return <span className="reconcile-segmented" role="group" aria-label={label}>
    <button className="ui-button" type="button" aria-pressed={value === "dashboard"} onClick={() => onChange("dashboard")}>{dashboard}</button>
    <button className="ui-button" type="button" aria-pressed={value === "discord"} onClick={() => onChange("discord")}>{discord}</button>
  </span>;
}

/** Reviews every paired member whose label and role disagree before a label starts syncing both ways. */
export function DiscordLabelReconciliation({ preview, onConfirm, onCancel, busy = false }: DiscordLabelReconciliationProps) {
  const [choices, setChoices] = useState<Record<string, ReconciliationChoice>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, setState] = useState<{ tone: "success" | "error"; message: string }>();
  const [saving, setSaving] = useState(false);
  const role = `@${preview.roleName}`; const rows = preview.mismatches; const attendance = preview.attendance;
  const decided = rows.filter((row) => choices[row.memberId]).length;
  const done = state?.tone === "success";
  const everyone = (choice: ReconciliationChoice) => setChoices(Object.fromEntries(rows.map((row) => [row.memberId, choice])));
  const everyoneValue = rows.length && rows.every((row) => choices[row.memberId] === "dashboard") ? "dashboard" : rows.length && rows.every((row) => choices[row.memberId] === "discord") ? "discord" : undefined;
  const outcome = (row: ReconciliationMismatch) => {
    const choice = choices[row.memberId];
    if (choice === "dashboard") return `${row.hasLabel ? "Add" : "Remove"} ${role} in Discord`;
    if (choice === "discord") return `${row.hasRole ? "Add" : "Remove"} ${preview.labelName} label`;
    return "Choose a side";
  };
  const tally = { addLabels: 0, removeLabels: 0, addRoles: 0, removeRoles: 0 };
  for (const row of rows) {
    const choice = choices[row.memberId];
    if (choice === "discord") { if (row.hasRole) tally.addLabels += 1; else tally.removeLabels += 1; }
    if (choice === "dashboard") { if (row.hasLabel) tally.addRoles += 1; else tally.removeRoles += 1; }
  }
  const summaryParts = [tally.addLabels && `add ${count(tally.addLabels, "label")}`, tally.removeLabels && `remove ${count(tally.removeLabels, "label")}`, tally.addRoles && `add ${count(tally.addRoles, "role")}`, tally.removeRoles && `remove ${count(tally.removeRoles, "role")}`].filter(Boolean) as string[];
  const summary = summaryParts.length ? `This will ${summaryParts.join(", ")}.` : "No changes chosen yet.";
  const undecided = rows.length - decided;
  const blocked = busy || saving ? "Working…" : undecided ? `Choose the correct side for ${count(undecided, "more person", "more people")}` : attendance.affectsAttendance && !acknowledged ? "Confirm that you understand the attendance warning" : "";
  const usage = list([attendance.attendanceRules && count(attendance.attendanceRules, "attendance rule"), attendance.weeklyTargets && count(attendance.weeklyTargets, "weekly target"), attendance.meetingAudiences && count(attendance.meetingAudiences, "meeting audience")].filter(Boolean) as string[]);
  async function confirm() {
    if (blocked) return;
    setSaving(true); setState(undefined);
    try { await onConfirm({ previewId: preview.previewId, choices, acknowledgeAttendance: acknowledged }); setState({ tone: "success", message: "Two-way sync is on. Changes are applied, and Discord is checked every 5 minutes." }); }
    catch (error) { setState({ tone: "error", message: (error as Error).message }); }
    finally { setSaving(false); }
  }
  return <section className="task-card ui-card discord-reconcile" aria-labelledby="discord-reconcile-title">
    <div className="discord-reconcile-heading">
      <div><h2 id="discord-reconcile-title">Turn on two-way sync</h2><p className="discord-reconcile-subline">Label <strong>{preview.labelName}</strong> and Discord role <strong>{role}</strong></p></div>
      {done ? <span className="status-pill ui-status" data-tone="success">Two-way sync on</span> : <span className="status-pill ui-status" data-tone="warning">Not turned on yet</span>}
    </div>
    {!done && <>
      {rows.length ? <p>These people have the label but not the role, or the role but not the label. Choose which side is correct. Nothing changes until you confirm.</p> : <p>Everyone already matches.</p>}
      {attendance.affectsAttendance && <div className="ui-status discord-reconcile-callout" data-tone="warning" role="note">
        <strong>This label affects attendance</strong>
        <p>{preview.labelName} is used by {usage}. With two-way sync on, adding or removing {role} in Discord changes these members' attendance requirements.</p>
        <label className="checkbox-field"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />I understand</label>
      </div>}
      {rows.length > 0 && <>
        <div className="discord-reconcile-toolbar">
          <p aria-live="polite">{rows.length === 1 ? "1 person doesn't match" : `${rows.length} people don't match`} · {decided} of {rows.length} decided</p>
          <div className="discord-reconcile-everyone"><span>For everyone:</span><SideControl label="Correct side for everyone" value={everyoneValue || undefined} onChange={everyone} dashboard="Use dashboard" discord="Use Discord" /></div>
        </div>
        <div className="table-scroll"><table className="data-table discord-reconcile-table">
          <thead><tr><th scope="col">Member</th><th scope="col">Dashboard</th><th scope="col">Discord</th><th scope="col">Correct side</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.memberId}>
            <th scope="row" data-label="Member"><span className="discord-reconcile-name">{row.name}</span><small>{row.memberId}</small></th>
            <td data-label="Dashboard"><span className="status-pill ui-status" data-tone={row.hasLabel ? "success" : "neutral"}>{row.hasLabel ? "Has label" : "No label"}</span></td>
            <td data-label="Discord"><span className="status-pill ui-status" data-tone={row.hasRole ? "success" : "neutral"}>{row.hasRole ? "Has role" : "No role"}</span></td>
            <td data-label="Correct side"><div className="discord-reconcile-choice"><SideControl label={`Correct side for ${row.name}`} value={choices[row.memberId]} onChange={(choice) => setChoices((old) => ({ ...old, [row.memberId]: choice }))} /><small data-unset={choices[row.memberId] ? undefined : "true"}>{outcome(row)}</small></div></td>
          </tr>)}</tbody>
        </table></div>
      </>}
      {preview.unmatchedCount > 0 && <p className="discord-reconcile-note">{count(preview.unmatchedCount, "Discord user")} with {role} {preview.unmatchedCount === 1 ? "isn't" : "aren't"} linked to anyone on the roster. They're listed in Debug tools on the Kiosks page and won't be changed.</p>}
    </>}
    {state && <p className="ui-status settings-notice" data-tone={state.tone} role="status">{state.message}</p>}
    <div className="discord-reconcile-footer">
      {!done && rows.length > 0 && <p className="discord-reconcile-summary">{summary}</p>}
      <div className="dialog-actions">
        {done ? <button className="ui-button" type="button" onClick={onCancel}>Close</button> : <>
          <button className="ui-button" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
          <button className="ui-button ui-button--primary" type="button" disabled={Boolean(blocked)} title={blocked || undefined} onClick={() => void confirm()}>Confirm and turn on two-way sync</button>
        </>}
      </div>
    </div>
  </section>;
}
