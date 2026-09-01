import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useModalFocus } from "./modal-focus";
import { UserSettings, type RosterMember } from "./user-settings";
import { RosterImportPanel } from "./roster-import-panel";

type NewMember = { memberId: string; firstName: string; lastName: string; email: string; discordUserId: string };
const emptyMember = (): NewMember => ({ memberId: "", firstName: "", lastName: "", email: "", discordUserId: "" });

function AddMemberDialog({ open, members, onClose, onAdded }: { open: boolean; members: RosterMember[]; onClose: () => void; onAdded: () => Promise<void> }) {
  const [member, setMember] = useState<NewMember>(emptyMember); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, open, busy, onClose);
  if (!open) return null;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (members.some((current) => current.memberId.toLocaleLowerCase() === member.memberId.trim().toLocaleLowerCase())) { setError("That member ID already exists. Use roster import to update an existing member."); return; }
    if (member.discordUserId && !/^\d{10,24}$/.test(member.discordUserId)) { setError("Discord ID must contain 10 to 24 digits, or be left blank."); return; }
    setBusy(true);
    try { await api("/admin/members", { method: "POST", body: JSON.stringify({ mode: "merge", members: [{ ...member, memberId: member.memberId.trim(), firstName: member.firstName.trim(), lastName: member.lastName.trim(), email: member.email.trim() || undefined, discordUserId: member.discordUserId.trim() || undefined }] }) }); await onAdded(); setMember(emptyMember()); onClose(); }
    catch (caught) { setError((caught as Error).message); window.requestAnimationFrame(() => document.getElementById("add-member-error")?.focus()); }
    finally { setBusy(false); }
  }
  return <div className="dialog-backdrop"><div className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="add-member-title" tabIndex={-1} ref={dialog}><form onSubmit={submit}><div className="dialog-heading"><div><h2 id="add-member-title">Add roster member</h2><p>Add one person without preparing a CSV file.</p></div><button type="button" aria-label="Close add member dialog" disabled={busy} onClick={onClose}>×</button></div><label>Member ID<input required maxLength={80} value={member.memberId} onChange={(event) => setMember({ ...member, memberId: event.target.value })} /></label><div className="form-grid"><label>First name<input required maxLength={80} value={member.firstName} onChange={(event) => setMember({ ...member, firstName: event.target.value })} /></label><label>Last name<input required maxLength={80} value={member.lastName} onChange={(event) => setMember({ ...member, lastName: event.target.value })} /></label></div><label>Email <span>(optional)</span><input type="email" maxLength={254} value={member.email} onChange={(event) => setMember({ ...member, email: event.target.value })} /></label><label>Discord user ID <span>(optional)</span><input inputMode="numeric" pattern="[0-9]{10,24}" value={member.discordUserId} onChange={(event) => setMember({ ...member, discordUserId: event.target.value })} /></label>{error && <p id="add-member-error" className="inline-messages error" role="alert" tabIndex={-1}>{error}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? "Adding…" : "Add member"}</button></div></form></div></div>;
}

export function RosterPage({ role }: { role: "admin" | "operator" }) {
  const [members, setMembers] = useState<RosterMember[]>([]); const [notice, setNotice] = useState("Loading roster…"); const [importOpen, setImportOpen] = useState(false); const [addOpen, setAddOpen] = useState(false);
  async function load(message = "") { const result = await api<{ members: RosterMember[] }>("/admin/members"); setMembers(result.members); setNotice(message); }
  useEffect(() => { void load().catch((error: Error) => setNotice(error.message)); }, []);
  const activeCount = members.filter((member) => member.active).length;
  return <div className="page-stack"><section className="page-stack" aria-labelledby="roster-title"><div className="page-intro"><h1 id="roster-title">Roster</h1></div>{notice && <p className="setup-status" role="status">{notice}</p>}<article className="roster-summary-card"><div><span>Active roster</span><strong>{activeCount}</strong></div>{role === "admin" && <div className="roster-actions"><button type="button" onClick={() => setImportOpen(true)}>Import roster</button><button className="primary-button" type="button" onClick={() => setAddOpen(true)}>Add member</button></div>}</article><section className="task-card roster-directory" aria-labelledby="roster-directory-title"><h2 id="roster-directory-title">Roster members</h2><div className="roster-list" role="table" aria-label="Roster members"><div className="roster-row header" role="row"><span>Name</span><span>Member ID</span><span>Status</span></div>{members.map((current) => <div className="roster-row" role="row" key={current.id}><span><strong>{current.firstName} {current.lastName}</strong><small>{current.email || "No email"}</small></span><code>{current.memberId}</code><span>{current.active ? "Active" : "Inactive"}</span></div>)}</div>{members.length === 0 && <p className="empty-state">No roster members yet.</p>}</section></section>{role === "admin" && <UserSettings members={members} />}<RosterImportPanel open={importOpen} onClose={() => setImportOpen(false)} members={members} onImported={() => load("Roster import complete.")} /><AddMemberDialog open={addOpen} onClose={() => setAddOpen(false)} members={members} onAdded={() => load("Roster member added.")} /></div>;
}
