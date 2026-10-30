import { type ChangeEvent, useMemo, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useModalFocus } from "./modal-focus";
import { parseRosterText, rosterFieldHelp, rosterFieldLabels, rosterTemplateCsv, type RosterField, type RosterRecord } from "./roster-csv";
import type { RosterMember } from "./user-settings";

type IncomingMember = RosterRecord;
type PreviewRow = IncomingMember & { status: "Add" | "Update" | "Unchanged" | "Deactivate"; accountLinked?: boolean };

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([rosterTemplateCsv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a");
  link.href = url; link.download = "roster-template.csv"; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// `embedded` hides the panel's own heading before preview, when a surrounding dialog already titles the import.
type Props = { members: RosterMember[]; onImported: () => Promise<void>; open?: boolean; onClose?: () => void; embedded?: boolean };

export function RosterImportPanel({ members, onImported, open, onClose, embedded }: Props) {
  const modal = open !== undefined; const visible = !modal || open;
  const [csv, setCsv] = useState(""); const [sourceName, setSourceName] = useState(""); const [readingFile, setReadingFile] = useState(false); const [mode, setMode] = useState<"merge" | "replace">("merge"); const [preview, setPreview] = useState<PreviewRow[]>(); const [incoming, setIncoming] = useState<IncomingMember[]>([]); const [errors, setErrors] = useState<string[]>([]); const [warnings, setWarnings] = useState<string[]>([]); const [recognised, setRecognised] = useState<RosterField[]>([]); const [busy, setBusy] = useState(false); const dialog = useRef<HTMLDivElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const existing = useMemo(() => new Map(members.map((member) => [member.memberId, member])), [members]);

  useModalFocus(dialog, modal && visible, busy, () => { if (preview) setPreview(undefined); else onClose?.(); });

  function close() { if (busy) return; setPreview(undefined); setErrors([]); setWarnings([]); onClose?.(); }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setCsv(""); setPreview(undefined); setWarnings([]); setSourceName("");
    if (!/\.csv$/i.test(file.name) || !file.size || file.size > 1_048_576) {
      setErrors(["Choose a nonempty .csv file no larger than 1 MiB."]);
      return;
    }
    setReadingFile(true); setErrors([]);
    try { setCsv(await file.text()); setSourceName(file.name); }
    catch { setErrors(["The CSV file could not be read. Try selecting it again."]); }
    finally { setReadingFile(false); }
  }
  function prepare() {
    const parsed = parseRosterText(csv); const nextErrors = [...parsed.errors]; const nextWarnings = parsed.ignored.length ? [`Ignored columns: ${parsed.ignored.join(", ")}`] : [];
    const seen = new Set<string>(); const values = parsed.hasHeader && nextErrors.length ? [] : parsed.rows.filter(({ rowNumber, member }) => {
      if (!member.memberId || !member.firstName || !member.lastName) nextErrors.push(`Row ${rowNumber} is missing a required value.`);
      if (seen.has(member.memberId)) nextErrors.push(`Row ${rowNumber} repeats member ID ${member.memberId}.`); seen.add(member.memberId);
      if (member.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) nextErrors.push(`Row ${rowNumber} has an invalid email address.`);
      if (member.discordUserId && !/^\d{10,24}$/.test(member.discordUserId)) nextWarnings.push(`Row ${rowNumber} has an invalid Discord ID. It will be left unlinked.`);
      return Boolean(member.memberId || member.firstName || member.lastName);
    }).map(({ member }) => ({ ...member, discordUserId: /^\d{10,24}$/.test(member.discordUserId ?? "") ? member.discordUserId : undefined }));
    if (!values.length && !(parsed.hasHeader && parsed.errors.length)) nextErrors.push("Add at least one roster row.");
    if (values.length > 500) nextErrors.push("Import no more than 500 roster members at a time.");
    setErrors(nextErrors); setWarnings(nextWarnings); setRecognised(parsed.recognised);
    if (nextErrors.length) { window.requestAnimationFrame(() => document.getElementById("roster-import-errors")?.focus()); return; }
    const rows: PreviewRow[] = values.map((member) => { const current = existing.get(member.memberId); const unchanged = current && current.firstName === member.firstName && current.lastName === member.lastName && (current.email ?? "") === (member.email ?? "") && (current.discordUserId ?? "") === (member.discordUserId ?? "") && Boolean(current.active); return { ...member, status: !current ? "Add" : unchanged ? "Unchanged" : "Update" }; });
    if (mode === "replace") for (const member of members.filter((item) => item.active && !seen.has(item.memberId))) rows.push({ memberId: member.memberId, firstName: member.firstName, lastName: member.lastName, email: member.email, discordUserId: member.discordUserId, status: "Deactivate", accountLinked: Boolean(member.hasDashboardAccess) });
    setIncoming(values); setPreview(rows); window.requestAnimationFrame(() => dialog.current?.focus());
  }
  async function confirm() {
    setBusy(true);
    try { const result = await api<{ warnings?: string[] }>("/admin/members", { method: "POST", body: JSON.stringify({ members: incoming, mode }) }); await onImported(); setWarnings(result.warnings ?? []); setPreview(undefined); if (modal) onClose?.(); }
    catch (error) { setErrors([(error as Error).message]); setPreview(undefined); window.requestAnimationFrame(() => document.getElementById("roster-import-errors")?.focus()); }
    finally { setBusy(false); }
  }

  if (!visible) return null;
  const linkedDeactivations = preview?.filter((row) => row.status === "Deactivate" && row.accountLinked).length ?? 0;
  const filePicker = <div className="roster-import-file" role="group" aria-labelledby="roster-import-file-label">
    <span id="roster-import-file-label">CSV file</span>
    <div className="roster-import-file-controls">
      <button type="button" aria-label="Choose CSV file" disabled={readingFile} onClick={() => fileInput.current?.click()}>Choose File</button>
      <span className="roster-import-filename" aria-live="polite">{sourceName || "No file chosen"}</span>
      <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="CSV file" hidden tabIndex={-1} disabled={readingFile} onChange={(event) => void chooseFile(event)} />
    </div>
  </div>;
  const formatHelp = <div className="roster-import-format" role="group" aria-labelledby="roster-import-format-title"><div className="roster-import-format-heading"><span id="roster-import-format-title">CSV format</span><button type="button" onClick={downloadTemplate}>Download template</button></div><table className="roster-format-table"><caption className="visually-hidden">Roster CSV columns</caption><thead><tr><th scope="col">Column</th><th scope="col">Required</th><th scope="col">Example</th></tr></thead><tbody>{rosterFieldHelp.map((column) => <tr key={column.field}><th scope="row">{column.label}</th><td>{column.required ? "Required" : "Optional"}</td><td>{column.field === "discordUserId" ? column.example : <code>{column.example}</code>}</td></tr>)}</tbody></table><p id="roster-import-help" className="field-help">Header names are matched loosely, so "First Name", "first_name" and "firstName" all work. Spreadsheet rows pasted without a header must use this column order.</p></div>;
  const warningMessages = warnings.length > 0 && <div className="inline-messages warning" role="status"><strong>Review before importing</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>;
  const content = <section className={modal ? "roster-import-dialog" : "task-card roster-import"} aria-labelledby={embedded && !preview ? undefined : "roster-import-title"}>{embedded && !preview ? null : <div className="dialog-heading"><div><h2 id="roster-import-title">{preview ? "Confirm roster import" : "Import roster"}</h2><p>{preview ? mode === "replace" ? "This preview includes members who will become inactive." : "Review additions and changes before importing." : "Upload a CSV file or paste spreadsheet rows, then preview every change."}</p></div>{modal && <button type="button" aria-label="Close roster import" disabled={busy} onClick={close}>×</button>}</div>}{!preview ? <><label>Import behavior<select value={mode} onChange={(event) => setMode(event.target.value as "merge" | "replace")}><option value="merge">Add to or update the current roster</option><option value="replace">Replace the active roster</option></select></label>{filePicker}{sourceName && <p className="field-help" role="status">Loaded {sourceName}. Review the rows below before previewing.</p>}<label>Roster CSV or spreadsheet rows<textarea className="code-textarea" rows={7} value={csv} placeholder="Paste CSV with headers or tab-separated spreadsheet rows" disabled={readingFile} onChange={(event) => { setCsv(event.target.value); setSourceName(""); setErrors([]); setWarnings([]); }} aria-describedby={errors.length ? "roster-import-errors" : "roster-import-help"} aria-invalid={errors.length > 0} /></label>{formatHelp}{mode === "replace" && <p className="warning-callout">Members omitted from the file become inactive. Attendance history and dashboard credentials are preserved.</p>}{errors.length > 0 && <div id="roster-import-errors" className="inline-messages error" role="alert" tabIndex={-1}><strong>Please fix the roster file</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}{warningMessages}<div className="dialog-actions">{modal && <button type="button" onClick={close}>Cancel</button>}<button className="primary-button" type="button" disabled={readingFile} onClick={prepare}>{readingFile ? "Reading file…" : "Preview roster"}</button></div></> : <>{linkedDeactivations > 0 && <p className="warning-callout" role="alert">{linkedDeactivations} omitted member{linkedDeactivations === 1 ? " has" : "s have"} dashboard access. Their credentials will remain active and can be managed below.</p>}<p className="field-help roster-import-recognised">Recognised columns: {recognised.map((field) => rosterFieldLabels[field]).join(", ")}</p>{warningMessages}<div className="table-scroll"><table className="data-table roster-preview-table"><caption className="visually-hidden">Processed roster import</caption><thead><tr><th scope="col">Change</th><th scope="col">Member ID</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Discord ID</th></tr></thead><tbody>{preview.map((member) => <tr key={`${member.status}:${member.memberId}`}><td><span className={`change-badge ${member.status.toLowerCase()}`}>{member.status}</span></td><td><code>{member.memberId}</code></td><td>{member.firstName} {member.lastName}</td><td>{member.email || "—"}</td><td>{member.discordUserId || "—"}</td></tr>)}</tbody></table></div><div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>Back</button><button className="primary-button" type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "Importing…" : mode === "replace" ? "Confirm replacement" : "Confirm import"}</button></div></>}</section>;
  return modal ? <div className="dialog-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="roster-import-title" tabIndex={-1} ref={dialog}>{content}</div></div> : content;
}
