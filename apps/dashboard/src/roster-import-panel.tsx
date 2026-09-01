import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./dashboard-api";
import type { RosterMember } from "./user-settings";

type IncomingMember = { memberId: string; firstName: string; lastName: string; email?: string; discordUserId?: string };
type PreviewRow = IncomingMember & { status: "Add" | "Update" | "Unchanged" | "Deactivate"; accountLinked?: boolean };

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let value = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(value.trim()); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) { if (character === "\r" && text[index + 1] === "\n") index += 1; row.push(value.trim()); if (row.some(Boolean)) rows.push(row); row = []; value = ""; }
    else value += character;
  }
  row.push(value.trim()); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function RosterImportPanel({ members, onImported }: { members: RosterMember[]; onImported: () => Promise<void> }) {
  const [csv, setCsv] = useState("memberId,firstName,lastName,email,discordUserId\n"); const [mode, setMode] = useState<"merge" | "replace">("merge"); const [preview, setPreview] = useState<PreviewRow[]>(); const [incoming, setIncoming] = useState<IncomingMember[]>([]); const [errors, setErrors] = useState<string[]>([]); const [warnings, setWarnings] = useState<string[]>([]); const [busy, setBusy] = useState(false); const dialog = useRef<HTMLDivElement>(null);
  const existing = useMemo(() => new Map(members.map((member) => [member.memberId, member])), [members]);
  useEffect(() => { if (!preview) return; const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setPreview(undefined); }; document.addEventListener("keydown", listener); dialog.current?.focus(); return () => document.removeEventListener("keydown", listener); }, [preview, busy]);
  function prepare() {
    const parsed = parseCsv(csv); const header = parsed.shift()?.map((value) => value.trim()) ?? []; const required = ["memberId", "firstName", "lastName"]; const nextErrors: string[] = []; const nextWarnings: string[] = [];
    if (required.some((name) => !header.includes(name))) nextErrors.push("Header row requires memberId, firstName, and lastName.");
    const seen = new Set<string>(); const values = parsed.map((row, index) => Object.fromEntries(header.map((name, column) => [name, row[column] ?? ""])) as IncomingMember).filter((member, index) => {
      if (!member.memberId || !member.firstName || !member.lastName) nextErrors.push(`Row ${index + 2} is missing a required value.`);
      if (seen.has(member.memberId)) nextErrors.push(`Row ${index + 2} repeats member ID ${member.memberId}.`); seen.add(member.memberId);
      if (member.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email)) nextErrors.push(`Row ${index + 2} has an invalid email address.`);
      if (member.discordUserId && !/^\d{10,24}$/.test(member.discordUserId)) nextWarnings.push(`Row ${index + 2} has an invalid Discord ID. It will be left unlinked.`);
      return Boolean(member.memberId || member.firstName || member.lastName);
    }).map((member) => ({ ...member, discordUserId: /^\d{10,24}$/.test(member.discordUserId ?? "") ? member.discordUserId : undefined }));
    if (!values.length) nextErrors.push("Add at least one roster row."); setErrors(nextErrors); setWarnings(nextWarnings);
    if (nextErrors.length) { window.requestAnimationFrame(() => document.getElementById("roster-import-errors")?.focus()); return; }
    const rows: PreviewRow[] = values.map((member) => { const current = existing.get(member.memberId); const unchanged = current && current.firstName === member.firstName && current.lastName === member.lastName && (current.email ?? "") === (member.email ?? "") && (current.discordUserId ?? "") === (member.discordUserId ?? "") && Boolean(current.active); return { ...member, status: !current ? "Add" : unchanged ? "Unchanged" : "Update" }; });
    if (mode === "replace") for (const member of members.filter((item) => item.active && !seen.has(item.memberId))) rows.push({ memberId: member.memberId, firstName: member.firstName, lastName: member.lastName, email: member.email, discordUserId: member.discordUserId, status: "Deactivate", accountLinked: Boolean(member.hasDashboardAccess) });
    setIncoming(values); setPreview(rows);
  }
  async function confirm() {
    setBusy(true); try { const result = await api<{ imported: number; deactivated: number; warnings?: string[] }>("/admin/members", { method: "POST", body: JSON.stringify({ members: incoming, mode }) }); await onImported(); setPreview(undefined); setWarnings(result.warnings ?? []); } catch (error) { setErrors([(error as Error).message]); setPreview(undefined); window.requestAnimationFrame(() => document.getElementById("roster-import-errors")?.focus()); } finally { setBusy(false); }
  }
  const linkedDeactivations = preview?.filter((row) => row.status === "Deactivate" && row.accountLinked).length ?? 0;
  return <section className="task-card roster-import" aria-labelledby="roster-import-title"><h2 id="roster-import-title">Import roster</h2><label>Import behavior<select value={mode} onChange={(event) => setMode(event.target.value as "merge" | "replace")}><option value="merge">Add to or update the current roster</option><option value="replace">Replace the active roster</option></select></label><label>Roster CSV<textarea rows={7} value={csv} onChange={(event) => setCsv(event.target.value)} aria-describedby={errors.length ? "roster-import-errors" : "roster-import-help"} aria-invalid={errors.length > 0} /></label><p id="roster-import-help" className="field-help">Required: memberId, firstName, lastName. Optional: email and discordUserId.</p>{mode === "replace" && <p className="warning-callout">Members omitted from the file become inactive. Attendance history and dashboard credentials are preserved.</p>}{errors.length > 0 && <div id="roster-import-errors" className="inline-messages error" role="alert" tabIndex={-1}><strong>Please fix the roster file</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}{warnings.length > 0 && <div className="inline-messages warning" role="status"><strong>Review these optional fields</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}<button className="primary-button" type="button" onClick={prepare}>Preview roster</button>{preview && <div className="dialog-backdrop"><div className="roster-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="roster-preview-title" tabIndex={-1} ref={dialog}><div className="dialog-heading"><div><h2 id="roster-preview-title">Confirm roster import</h2><p>{mode === "replace" ? "This preview includes members who will become inactive." : "Review additions and changes before importing."}</p></div><button type="button" aria-label="Close roster preview" disabled={busy} onClick={() => setPreview(undefined)}>×</button></div>{linkedDeactivations > 0 && <p className="warning-callout" role="alert">{linkedDeactivations} omitted member{linkedDeactivations === 1 ? " has" : "s have"} dashboard access. Their credentials will remain active and can be managed below.</p>}<div className="table-scroll"><table className="data-table roster-preview-table"><caption className="visually-hidden">Processed roster import</caption><thead><tr><th scope="col">Change</th><th scope="col">Member ID</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Discord ID</th></tr></thead><tbody>{preview.map((member) => <tr key={`${member.status}:${member.memberId}`}><td><span className={`change-badge ${member.status.toLowerCase()}`}>{member.status}</span></td><td><code>{member.memberId}</code></td><td>{member.firstName} {member.lastName}</td><td>{member.email || "—"}</td><td>{member.discordUserId || "—"}</td></tr>)}</tbody></table></div><div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>Cancel</button><button className="primary-button" type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "Importing…" : mode === "replace" ? "Confirm replacement" : "Confirm import"}</button></div></div></div>}</section>;
}
