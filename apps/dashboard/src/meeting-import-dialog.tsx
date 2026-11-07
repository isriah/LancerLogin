import { type ChangeEvent, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { downloadCsvTemplate, formatCsvDate, formatCsvTimeRange } from "./csv-import.ts";
import { useModalFocus } from "./modal-focus";
import { meetingCsvFieldHelp, meetingCsvFieldLabels, meetingCsvRowLimit, meetingCsvTemplate, parseMeetingCsvText, type MeetingCsvField, type MeetingCsvRow } from "../../../packages/shared/src/meeting-csv.ts";

type Local = { title: string; date: string; startTime: string; endDate: string; endTime: string; required: boolean; audience: string[] };
export type MeetingImportRow = { rowNumber: number; action: "add" | "update" | "skip" | "error"; past: boolean; meeting?: Local; existing?: Local & { meetingId: string }; changes?: string[]; error?: string };
type Summary = { add: number; update: number; skip: number; error: number; past: number };
export type MeetingImportResult = { rows: MeetingImportRow[]; summary: Summary; imported?: { added: number; updated: number; meetingIds: string[] }; calendar?: { googleQueued: number; discordQueued: number } };
type Choice = "skip" | "update";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const downloadTemplate = () => downloadCsvTemplate("meetings-template.csv", meetingCsvTemplate);
const timeText = (meeting: Local) => `${formatCsvTimeRange(meeting.startTime, meeting.endTime)}${meeting.endDate !== meeting.date ? " (next day)" : ""}`;
const audienceText = (meeting: Local) => meeting.audience.length ? meeting.audience.join("; ") : "All members";
const attendanceText = (meeting: Local) => meeting.required ? "Required" : "Optional";
const sentence = (error: string) => `${error[0]!.toLowerCase()}${error.slice(1)}${/[.!?]$/.test(error) ? "" : "."}`;

/** Old and new values of a changed field, as <del>old</del> → <ins>new</ins>. */
function Change({ from, to }: { from: string; to: string }) {
  return <><del>{from}</del> <span className="import-arrow" aria-hidden="true">→</span> <ins>{to}</ins></>;
}

type Props = { open: boolean; timeZone: string; onClose: () => void; onImported: (result: MeetingImportResult) => Promise<void> };

/** Import meetings from CSV: upload or paste, then a server dry run previews every row before anything is written. */
export function MeetingImportDialog({ open, timeZone, onClose, onImported }: Props) {
  const [csv, setCsv] = useState(""); const [sourceName, setSourceName] = useState(""); const [readingFile, setReadingFile] = useState(false);
  const [rows, setRows] = useState<MeetingCsvRow[]>([]); const [recognised, setRecognised] = useState<MeetingCsvField[]>([]); const [ignored, setIgnored] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]); const [preview, setPreview] = useState<MeetingImportResult>(); const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false); const dialog = useRef<HTMLDivElement>(null); const fileInput = useRef<HTMLInputElement>(null);

  useModalFocus(dialog, open, busy, () => { if (preview) setPreview(undefined); else close(); });

  function close() { if (busy) return; setPreview(undefined); setErrors([]); setChoices({}); onClose(); }
  function showErrors(next: string[]) { setErrors(next); window.requestAnimationFrame(() => document.getElementById("meeting-import-errors")?.focus()); }
  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setCsv(""); setPreview(undefined); setSourceName("");
    if (!/\.csv$/i.test(file.name) || !file.size || file.size > 1_048_576) { setErrors(["Choose a nonempty .csv file no larger than 1 MiB."]); return; }
    setReadingFile(true); setErrors([]);
    try { setCsv(await file.text()); setSourceName(file.name); }
    catch { setErrors(["The CSV file could not be read. Try selecting it again."]); }
    finally { setReadingFile(false); }
  }
  async function dryRun(nextRows: MeetingCsvRow[], nextChoices: Record<string, Choice>) {
    setBusy(true);
    try { setPreview(await api<MeetingImportResult>("/meetings/import", { method: "POST", body: JSON.stringify({ rows: nextRows, dryRun: true, actions: nextChoices }) })); setErrors([]); return true; }
    catch (error) { setPreview(undefined); showErrors([(error as Error).message]); return false; }
    finally { setBusy(false); }
  }
  async function prepare() {
    // The browser checks the file's shape; the server checks every row again and decides what each one does.
    const parsed = parseMeetingCsvText(csv); const next = [...parsed.errors];
    if (!parsed.rows.length && !(parsed.hasHeader && next.length)) next.push("Add at least one meeting row.");
    if (parsed.rows.length > meetingCsvRowLimit) next.push(`Import no more than ${meetingCsvRowLimit} meetings at a time.`);
    setRecognised(parsed.recognised); setIgnored(parsed.ignored);
    if (next.length) { showErrors(next); return; }
    setRows(parsed.rows); setChoices({});
    if (await dryRun(parsed.rows, {})) window.requestAnimationFrame(() => dialog.current?.focus());
  }
  function choose(next: Record<string, Choice>) { setChoices(next); void dryRun(rows, next); }
  async function confirm() {
    setBusy(true);
    try { const result = await api<MeetingImportResult>("/meetings/import", { method: "POST", body: JSON.stringify({ rows, dryRun: false, actions: choices }) }); setPreview(undefined); setCsv(""); setSourceName(""); setChoices({}); await onImported(result); onClose(); }
    catch (error) { showErrors([(error as Error).message]); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  const heading = <div className="dialog-heading"><div><h2 id="meeting-import-title">Import meetings</h2><p>{preview ? "Review each meeting before importing." : "Upload a CSV file or paste spreadsheet rows, then preview every meeting."}</p></div><button type="button" aria-label="Close meeting import" disabled={busy} onClick={close}>×</button></div>;
  const errorMessages = errors.length > 0 && <div id="meeting-import-errors" className="inline-messages error" role="alert" tabIndex={-1}><strong>Please fix the meetings file</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>;
  let content;
  if (!preview) {
    content = <>
      {heading}
      <div className="roster-import-file" role="group" aria-labelledby="meeting-import-file-label">
        <span id="meeting-import-file-label">CSV file</span>
        <div className="roster-import-file-controls">
          <button type="button" aria-label="Choose CSV file" disabled={readingFile} onClick={() => fileInput.current?.click()}>Choose File</button>
          <span className="roster-import-filename" aria-live="polite">{sourceName || "No file chosen"}</span>
          <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="CSV file" hidden tabIndex={-1} disabled={readingFile} onChange={(event) => void chooseFile(event)} />
        </div>
      </div>
      {sourceName && <p className="field-help" role="status">Loaded {sourceName}. Review the rows below before previewing.</p>}
      <label>Meetings CSV or spreadsheet rows<textarea className="code-textarea" rows={7} value={csv} placeholder="Paste CSV with headers or tab-separated spreadsheet rows" disabled={readingFile} onChange={(event) => { setCsv(event.target.value); setSourceName(""); setErrors([]); }} aria-describedby={errors.length ? "meeting-import-errors" : "meeting-import-help"} aria-invalid={errors.length > 0} /></label>
      <div className="roster-import-format" role="group" aria-labelledby="meeting-import-format-title">
        <div className="roster-import-format-heading"><span id="meeting-import-format-title">CSV format</span><button type="button" onClick={downloadTemplate}>Download template</button></div>
        <table className="roster-format-table"><caption className="visually-hidden">Meeting CSV columns</caption>
          <thead><tr><th scope="col">Column</th><th scope="col">Required</th><th scope="col">Example</th></tr></thead>
          <tbody>{meetingCsvFieldHelp.map((column) => <tr key={column.field}><th scope="row">{column.label}</th><td>{column.required}</td><td>{column.example && <code>{column.example}</code>}</td></tr>)}</tbody>
        </table>
        <p id="meeting-import-help" className="field-help">Header names are matched loosely, so "Start time", "start_time" and "startTime" all work. Dates use MM/DD/YYYY, such as 11/10/2026; 2026-11-10 also works. Times are in the organization's time zone ({timeZone}). Each row is one meeting.</p>
      </div>
      {errorMessages}
      <div className="dialog-actions"><button type="button" onClick={close}>Cancel</button><button className="primary-button" type="button" disabled={readingFile || busy} onClick={() => void prepare()}>{readingFile ? "Reading file…" : busy ? "Checking…" : "Preview meetings"}</button></div>
    </>;
  } else {
    const { summary } = preview; const importing = summary.add + summary.update; const problems = preview.rows.filter((row) => row.action === "error");
    const matched = preview.rows.filter((row) => row.existing); const updates = matched.filter((row) => choices[row.rowNumber] === "update").length;
    const bulk = !matched.length ? undefined : updates === matched.length ? "update" : updates === 0 ? "skip" : "mixed";
    const setAll = (choice: Choice) => choose(Object.fromEntries(matched.map((row) => [row.rowNumber, choice])));
    const warnings = [
      ...(summary.past ? [summary.past === 1 ? "1 meeting is in the past. It counts toward attendance for its audience, and no Discord absence notice is sent for it." : `${summary.past} meetings are in the past. They count toward attendance for their audience, and no Discord absence notices are sent for them.`] : []),
      ...(ignored.length ? [`Ignored columns: ${ignored.join(", ")}`] : []),
    ];
    const parts = [summary.add && `${summary.add} to add`, summary.update && `${summary.update} to update`, summary.skip && `${summary.skip} skipped as a duplicate`, summary.error && `${summary.error} with a problem`].filter(Boolean);
    content = <>
      {heading}
      {warnings.length > 0 && <div className="inline-messages warning" role="status"><strong>Review before importing</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
      <div className="import-preview-bar">
        <p className="field-help roster-import-recognised">Recognised columns: {recognised.map((field) => meetingCsvFieldLabels[field]).join(", ")}</p>
        {bulk && <div className="import-match-bulk">
          <fieldset className="meeting-view-toggle import-match-choice"><legend>Matching rows:</legend><div>
            {(["skip", "update"] as const).map((choice) => <label key={choice} className={bulk === choice ? "selected" : undefined}><input type="radio" name="meeting-match-action" value={choice} checked={bulk === choice} disabled={busy} onChange={() => setAll(choice)} />{choice === "skip" ? "Skip all" : "Update all"}</label>)}
          </div></fieldset>
          {bulk === "mixed" && <span className="import-match-state">Mixed</span>}
        </div>}
      </div>
      <div className="table-scroll"><table className="data-table roster-preview-table import-preview-table"><caption className="visually-hidden">Processed meeting import</caption>
        <thead><tr><th scope="col">Change</th><th scope="col">Title</th><th scope="col">Date</th><th scope="col">Time</th><th scope="col">Attendance</th><th scope="col">Audience</th><th scope="col">Issues</th></tr></thead>
        <tbody>{preview.rows.map((row) => {
          const meeting = row.meeting; const existing = row.existing; const shown = row.action === "update" && existing;
          const changed = (name: string) => Boolean(shown && row.changes?.includes(name));
          const choice = choices[row.rowNumber] ?? "skip";
          const badge = existing ? <select className={`ui-native-select import-row-select ${choice}`} aria-label={`Action for ${meeting?.title ?? existing.title}`} value={choice} disabled={busy} onChange={(event) => choose({ ...choices, [row.rowNumber]: event.target.value as Choice })}><option value="skip">Skip</option><option value="update">Update</option></select>
            : <span className={`change-badge ${row.action}`}>{row.action === "error" ? "Error" : row.action === "add" ? "Add" : "Skip"}</span>;
          const past = row.past && (row.action === "add" || row.action === "update");
          const issue = row.error ?? (existing ? `Matches existing · ${row.changes?.length ? `changes ${row.changes.join(", ").replace(/, ([^,]*)$/, " and $1")}` : "no changes"}` : "—");
          return <tr key={row.rowNumber}>
            <td>{past ? <span className="import-row-flags">{badge}<span className="ui-status" data-tone="warning">Past</span></span> : badge}</td>
            <td className={changed("title") ? "import-change" : undefined}>{changed("title") ? <Change from={existing!.title} to={meeting!.title} /> : meeting?.title ?? "—"}</td>
            <td>{meeting ? formatCsvDate(meeting.date) : "—"}</td>
            <td className={changed("end time") ? "import-change" : undefined}>{!meeting ? "—" : changed("end time") ? <Change from={timeText(existing!)} to={timeText(meeting)} /> : timeText(meeting)}</td>
            <td className={changed("attendance") ? "import-change" : undefined}>{!meeting ? "—" : changed("attendance") ? <Change from={attendanceText(existing!)} to={attendanceText(meeting)} /> : attendanceText(meeting)}</td>
            <td className={changed("audience") ? "import-change" : undefined}>{!meeting ? "—" : changed("audience") ? <Change from={audienceText(existing!)} to={audienceText(meeting)} /> : audienceText(meeting)}</td>
            <td className={row.error ? "import-issue-error" : undefined}>{issue}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {problems.length > 0 && <div id="meeting-import-errors" className="inline-messages error" role="alert" tabIndex={-1}><strong>{problems.length === 1 ? "1 row has" : `${problems.length} rows have`} a problem and won't be imported.</strong> Fix the file and preview again, or import the other rows.<ul>{problems.map((row) => <li key={row.rowNumber}>Row {row.rowNumber}{row.meeting ? `, ${row.meeting.title}` : ""}: {sentence(row.error!)}</li>)}</ul></div>}
      {errors.length > 0 && !problems.length && errorMessages}
      <p className="field-help import-preview-summary" role="status">{parts.join(", ")}.</p>
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>Back</button><button className="primary-button" type="button" disabled={busy || !importing} onClick={() => void confirm()}>{busy ? "Working…" : `Import ${plural(importing, "meeting", "meetings")}${problems.length ? ` (skip ${plural(problems.length, "row", "rows")} with a problem)` : ""}`}</button></div>
    </>;
  }
  return <div className="dialog-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="meeting-import-title" tabIndex={-1} ref={dialog}><section className="roster-import-dialog" aria-labelledby="meeting-import-title">{content}</section></div></div>;
}
