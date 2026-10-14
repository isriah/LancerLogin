import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { RouteLink, usePath } from "./router";
import type { RosterMember } from "./user-settings";

export function CoreMemberPage({ memberId }: { memberId: string }) {
  const { path, navigate } = usePath();
  const [member, setMember] = useState<RosterMember>();
  const [notice, setNotice] = useState("Loading member profile...");
  useEffect(() => {
    let active = true;
    void api<{ members: RosterMember[] }>("/admin/members").then((result) => {
      if (!active) return;
      const found = result.members.find((item) => item.memberId === memberId);
      setMember(found); setNotice(found ? "" : "Member not found.");
    }).catch((error: Error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, [memberId]);
  return <section className="page-stack member-detail-page" aria-labelledby="core-member-title"><RouteLink href="/roster" currentPath={path} navigate={navigate} className="back-link">← Back to roster</RouteLink><div className="page-intro"><p className="kicker">Core roster profile</p><h1 id="core-member-title">{member ? `${member.firstName} ${member.lastName}` : "Member profile"}</h1>{member && <p>{member.memberId}</p>}</div>{notice && <p className="setup-status" role="status">{notice}</p>}{member && <article className="task-card member-profile-card"><h2>Shared identity</h2><dl className="member-profile-details"><div><dt>Status</dt><dd>{member.active ? "Active" : "Inactive"}</dd></div><div><dt>Email</dt><dd>{member.email || "No email on file"}</dd></div><div><dt>Discord identity</dt><dd>{member.discordUserId || "Not linked"}</dd></div></dl><p>Enable and assign Attendance to view attendance history and corrections for this member.</p></article>}</section>;
}
