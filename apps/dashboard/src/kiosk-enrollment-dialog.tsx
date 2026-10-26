import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useModalFocus } from "./modal-focus";
import { visiblePoll } from "./visible-poll";

export type EnrollmentSession = { id: string; expiresAt: string; state: "waiting_member" | "ready" | "cancelled"; progress: string; member?: { rosterId: string; memberId: string; firstName: string; lastName: string } };
type Member = { id: string; memberId: string; firstName: string; lastName: string; active: boolean | number };
const ended = (session: EnrollmentSession) => ["enroll_success", "enroll_failure", "cancelled", "expired"].includes(session.progress);
const labels: Record<string, string> = { waiting_member: "Choose a member. The kiosk will open maintenance when it receives the request.", awaiting_confirmation: "Waiting for name confirmation on the kiosk.", enroll_wait_first: "Place a finger on the kiosk reader for the first scan.", enroll_remove: "First scan accepted. Lift the finger from the reader.", enroll_wait_second: "Place the same finger on the reader again.", enroll_success: "Fingerprint enrolled successfully.", enroll_failure: "Enrollment could not complete. Check the kiosk before trying again.", cancelled: "Enrollment cancelled.", expired: "Enrollment expired. Begin again when the member is ready." };

export function KioskEnrollmentDialog({ kiosk, initial, onClose }: { kiosk: { id: string; name: string }; initial: EnrollmentSession; onClose: () => void }) {
  const [session, setSession] = useState(initial), [members, setMembers] = useState<Member[]>([]), [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null), revision = useRef(0), closing = useRef(false);
  const base = `/admin/kiosks/${encodeURIComponent(kiosk.id)}/enrollment`;
  async function close() {
    if (closing.current) return;
    closing.current = true; revision.current++; setBusy(true); setError("");
    try { if (!ended(session)) await api(`${base}/${encodeURIComponent(session.id)}`, { method: "DELETE" }); onClose(); }
    catch (caught) { setError((caught as Error).message); }
    finally { closing.current = false; setBusy(false); }
  }
  useModalFocus(dialog, true, busy, () => { void close(); });
  useEffect(() => {
    let live = true;
    void api<{ members: Member[] }>("/admin/members").then(value => { if (live) setMembers(value.members.filter(member => member.active)); }).catch(caught => { if (live) setError((caught as Error).message); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (ended(session) || busy) return;
    let live = true;
    const stop = visiblePoll(async () => {
      const current = revision.current;
      try {
        const result = await api<{ session: EnrollmentSession | null }>(base);
        if (!live || current !== revision.current || closing.current) return;
        setSession(result.session?.id === session.id ? result.session : { ...session, state: "cancelled", progress: "expired" });
      } catch (caught) { if (live) setError((caught as Error).message); }
    }, 2_000);
    return () => { live = false; stop(); };
  }, [base, session.id, session.progress, busy]);
  async function select(member: Member) {
    revision.current++; setBusy(true); setError("");
    try { setSession((await api<{ session: EnrollmentSession }>(`${base}/${encodeURIComponent(session.id)}`, { method: "PATCH", body: JSON.stringify({ memberId: member.id }) })).session); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  async function again() {
    revision.current++; setBusy(true); setError("");
    try { setSession((await api<{ session: EnrollmentSession }>(base, { method: "POST" })).session); setSearch(""); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  const matching = members.filter(member => `${member.firstName} ${member.lastName} ${member.memberId}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="dialog-backdrop"><div className="ui-dialog kiosk-enrollment-dialog" role="dialog" aria-modal="true" aria-labelledby="kiosk-enrollment-title" aria-describedby="kiosk-enrollment-device" tabIndex={-1} ref={dialog}>
    <div className="dialog-heading"><h2 id="kiosk-enrollment-title">Fingerprint enrollment</h2><button className="ui-button" type="button" disabled={busy} aria-label="Close enrollment" onClick={() => void close()}>×</button></div>
    <p id="kiosk-enrollment-device">{kiosk.name}</p>
    {error && <p className="ui-status" data-tone="error" role="alert">{error}</p>}
    <p role="status" aria-live="polite">{labels[session.progress] ?? "Waiting for the kiosk."}</p>
    {session.member && <p><strong>{session.member.firstName} {session.member.lastName}</strong><br /><small>{session.member.memberId}</small></p>}
    {session.state === "waiting_member" && !ended(session) && <><label className="field">Search members<input type="search" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} placeholder="Name or member ID" /></label><div className="kiosk-enrollment-members" aria-label="Matching members">{matching.slice(0, 30).map(member => <button className="ui-button" type="button" disabled={busy} key={member.id} onClick={() => void select(member)}><span>{member.firstName} {member.lastName}</span><small>{member.memberId}</small></button>)}{members.length > 0 && matching.length === 0 && <p>No matching active members.</p>}{matching.length > 30 && <p>Refine the search to see more members.</p>}</div></>}
    <div className="dialog-actions">{ended(session) && <button className="ui-button primary-button" type="button" disabled={busy} onClick={() => void again()}>Enroll another member</button>}<button className="ui-button" type="button" disabled={busy} onClick={() => void close()}>{ended(session) ? "Done" : "Cancel enrollment"}</button></div>
  </div></div>;
}
