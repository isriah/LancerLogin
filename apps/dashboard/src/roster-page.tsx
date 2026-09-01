import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { UserSettings, type RosterMember } from "./user-settings";
import { RosterImportPanel } from "./roster-import-panel";

export function RosterPage({ role }: { role: "admin" | "operator" }) {
  const [members, setMembers] = useState<RosterMember[]>([]); const [notice, setNotice] = useState("Loading roster…");
  async function load() { const result = await api<{ members: RosterMember[] }>("/admin/members"); setMembers(result.members); setNotice(`${result.members.filter((member) => member.active).length} active roster member${result.members.filter((member) => member.active).length === 1 ? "" : "s"}.`); }
  useEffect(() => { void load().catch((error: Error) => setNotice(error.message)); }, []);
  return <div className="page-stack"><section aria-labelledby="roster-title"><div className="page-intro"><h1 id="roster-title">Roster</h1></div><p className="setup-status" role="status">{notice}</p>{role === "admin" && <RosterImportPanel members={members} onImported={load} />}<div className="roster-list" role="table" aria-label="Roster members"><div className="roster-row header" role="row"><span>Name</span><span>Member ID</span><span>Status</span></div>{members.map((member) => <div className="roster-row" role="row" key={member.id}><span><strong>{member.firstName} {member.lastName}</strong><small>{member.email || "No email"}</small></span><code>{member.memberId}</code><span>{member.active ? "Active" : "Inactive"}</span></div>)}</div></section>{role === "admin" && <UserSettings members={members} />}</div>;
}
