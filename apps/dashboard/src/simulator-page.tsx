import { useEffect, useState } from "react";
import { kioskDisplayForAttendance, kioskState, type KioskDisplay } from "../../kiosk/src/kiosk-presentation.mjs";
import { KioskPreview } from "./kiosk-preview";
import type { Branding } from "./setup-workspace";
import { api } from "./dashboard-api";

type Member = { id: string; memberId: string; firstName: string; lastName: string; active: boolean };
type Meeting = { id: string; title: string; startsAt: string };
type Simulator = { name: string; active: number; online: number };

// BrowserMemberInput is the emulator-specific input boundary. It has no kiosk
// credential, reader state, queue, or physical-kiosk status route.
function BrowserMemberInput({ members, meetings, memberId, meetingId, onMemberId, onMeetingId, onRead, disabled }: { members: Member[]; meetings: Meeting[]; memberId: string; meetingId: string; onMemberId: (value: string) => void; onMeetingId: (value: string) => void; onRead: () => void; disabled: boolean }) {
  return <section className="simulator-controls ui-form" aria-label="Browser input adapter"><div className="simulator-field"><label htmlFor="simulator-member">Roster member</label><select className="ui-native-select" id="simulator-member" value={memberId} onChange={(event) => onMemberId(event.target.value)}><option value="">Choose a member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.firstName} {member.lastName} · {member.memberId}</option>)}</select></div><div className="simulator-field"><label htmlFor="simulator-meeting">Meeting</label><select className="ui-native-select" id="simulator-meeting" value={meetingId} onChange={(event) => onMeetingId(event.target.value)}><option value="">Choose a meeting</option>{meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{new Date(meeting.startsAt).toLocaleDateString()} · {meeting.title}</option>)}</select></div><button className="primary-button" type="button" onClick={onRead} disabled={disabled}>Simulate member read</button></section>;
}

export function SimulatorPage({ branding }: { branding: Branding }) {
  const [simulator, setSimulator] = useState<Simulator>(); const [members, setMembers] = useState<Member[]>([]); const [meetings, setMeetings] = useState<Meeting[]>([]); const [memberId, setMemberId] = useState(""); const [meetingId, setMeetingId] = useState(""); const [display, setDisplay] = useState<KioskDisplay>(() => kioskState("ready")); const [busy, setBusy] = useState(false);
  async function load() { const [sim, roster, schedule] = await Promise.all([api<{ simulator: Simulator | null }>("/admin/simulator"), api<{ members: Member[] }>("/admin/members"), api<{ meetings: Meeting[] }>("/meetings")]); if (!sim.simulator?.active) throw new Error("Pair the browser simulator from guided setup before opening it."); setSimulator(sim.simulator); setMembers(roster.members.filter((member) => member.active)); setMeetings(schedule.meetings); }
  useEffect(() => { void load().catch((error: Error) => setDisplay(kioskState("rejected", { detail: error.message }))); }, []);
  useEffect(() => { if (!display.durationMs) return; const timeout = window.setTimeout(() => setDisplay(kioskState("ready")), display.durationMs); return () => window.clearTimeout(timeout); }, [display]);
  async function scan() { if (!memberId || !meetingId) { setDisplay(kioskState("rejected", { detail: "Choose both a roster member and meeting." })); return; } setBusy(true); setDisplay(kioskState("processing")); try { const result = await api<{ action: "check_in" | "check_out"; duplicate?: boolean }>("/admin/simulator", { method: "POST", body: JSON.stringify({ action: "scan", memberId, meetingId }) }); setDisplay(kioskDisplayForAttendance(result)); } catch (error) { setDisplay(kioskState("rejected", { detail: (error as Error).message })); } finally { setBusy(false); } }
  const selectedMember = members.find((member) => member.id === memberId);
  return <section className="simulator-page" aria-label="Browser kiosk simulator"><header><span>Browser kiosk emulator</span><strong>{simulator?.name ?? "Not paired"}</strong></header><p className="simulator-origin">SIMULATED · BROWSER INPUT</p><KioskPreview branding={branding} display={display} name={display.id !== "ready" && selectedMember ? `${selectedMember.firstName} ${selectedMember.lastName}` : undefined} meetingTitle={display.id !== "ready" ? meetings.find((meeting) => meeting.id === meetingId)?.title : undefined} /><p className="simulator-boundary">This emulator uses the physical kiosk’s shared display-state contract. It cannot pair hardware, submit a kiosk heartbeat, affect the physical active-kiosk record, or access fingerprint templates.</p><BrowserMemberInput members={members} meetings={meetings} memberId={memberId} meetingId={meetingId} onMemberId={setMemberId} onMeetingId={setMeetingId} onRead={() => void scan()} disabled={busy || !simulator?.online} /></section>;
}
