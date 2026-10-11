import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { useModalFocus } from "./modal-focus";
import "./fingerprint-reset.css";

type ResetCommand = { id: string; kioskName: string; acknowledgedAt: number | null; currentPairing: number };
type Overview = { resetCommands: ResetCommand[] };
type Notice = { message: string; failed?: boolean };

function ResetDialog({ resetId, onClose, onReset }: { resetId: string; onClose(): void; onReset(): Promise<void> }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  useModalFocus(dialog, true, busy, onClose);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || confirmation !== "RESET ALL FINGERPRINT MAPPINGS") return;
    setBusy(true); setNotice("");
    try {
      const result = await api<{ queued: boolean }>("/admin/kiosks/fingerprint-reset", { method: "POST", body: JSON.stringify({ resetId, confirmation }) });
      if (result.queued !== true) throw new Error("The reset was not confirmed. Retry the same request before changing anything.");
      await onReset(); onClose();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="dialog-backdrop"><div className="ui-dialog fingerprint-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="fingerprint-reset-title" aria-describedby="fingerprint-reset-description" tabIndex={-1} ref={dialog}>
    <form className="ui-form" onSubmit={event => void submit(event)}><h2 id="fingerprint-reset-title">Reset all fingerprint mappings</h2>
      <p id="fingerprint-reset-description">Clear fingerprint member-to-slot associations on every currently active paired kiosk. Reader templates are retained for deliberate replacement during re-enrollment. Cloud copies are deleted, and cloud storage and peer sync are disabled.</p>
      <p>Offline kiosks keep their old associations until they reconnect and complete the reset. Sharing remains blocked for each pending kiosk. Roster, attendance, kiosk pairing, badge and QR mappings are unchanged.</p>
      <label htmlFor="fingerprint-reset-confirmation">Type RESET ALL FINGERPRINT MAPPINGS<input id="fingerprint-reset-confirmation" className="ui-control" data-modal-initial-focus value={confirmation} disabled={busy} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label>
      {notice && <p className="ui-status" data-tone="error" role="alert">{notice}</p>}
      <div className="dialog-actions"><button className="ui-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="ui-button ui-button--danger" type="submit" disabled={busy || confirmation !== "RESET ALL FINGERPRINT MAPPINGS"}>{busy ? "Requesting reset…" : "Reset fingerprint mappings"}</button></div>
    </form>
  </div></div>;
}

export function FingerprintResetPanel({ onSharingChanged }: { onSharingChanged?(): void }) {
  const [overview, setOverview] = useState<Overview>(), [busy, setBusy] = useState(false), [notice, setNotice] = useState<Notice>(), [resetOpen, setResetOpen] = useState(false);
  const resetId = useRef<string>(crypto.randomUUID()), sequence = useRef(0);
  async function load() {
    const version = ++sequence.current; setBusy(true);
    try {
      const result = await api<Overview>("/admin/kiosks/fingerprint-reset");
      if (!Array.isArray(result?.resetCommands) || result.resetCommands.some(command => !command || typeof command.id !== "string" || !command.id || typeof command.kioskName !== "string" || !command.kioskName || command.acknowledgedAt !== null && (!Number.isSafeInteger(command.acknowledgedAt) || command.acknowledgedAt < 0) || command.currentPairing !== 0 && command.currentPairing !== 1)) throw new Error("Fingerprint reset status is unavailable.");
      if (version === sequence.current) { setOverview(result); setNotice(undefined); return true; }
    } catch (error) { if (version === sequence.current) { setOverview(undefined); setNotice({ message: (error as Error).message, failed: true }); } return false; }
    finally { if (version === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { ++sequence.current; }; }, []);
  async function onReset() {
    resetId.current = crypto.randomUUID();
    const loaded = await load(); onSharingChanged?.();
    setNotice({ message: loaded ? "Fingerprint reset queued. Reader templates remain. Cloud storage and peer sync are disabled; each kiosk below is pending until its durable reset acknowledgement." : "Fingerprint reset queued, but its status could not be refreshed. Reader templates remain and sharing is disabled. Refresh status to check pending kiosks.", failed: !loaded });
  }
  return <article className="task-card ui-form fingerprint-reset-panel" aria-labelledby="fingerprint-reenrollment-title">
    <h2 id="fingerprint-reenrollment-title">Fingerprint re-enrollment</h2>
    <p>After upgrading, re-enroll older fingerprints using Authentication maintenance on a kiosk while it is online. Older mappings cannot be approved for sharing by looking up a member ID. New enrollments can use automatic fingerprint sharing.</p>
    <p>To start over, explicitly reset fingerprint mappings below, then wait for every kiosk to complete the reset before re-enrolling. This does not erase reader templates. Replace only a known occupied slot during re-enrollment; never overwrite an unknown slot.</p>
    <div className="kiosk-actions"><button className="ui-button" type="button" disabled={busy} onClick={() => void load()}>Refresh status</button><button className="ui-button ui-button--danger" type="button" disabled={busy || !overview} onClick={() => setResetOpen(true)}>Reset all fingerprint mappings</button></div>
    {notice && <p className="ui-status" data-tone={notice.failed ? "error" : "success"} role={notice.failed ? "alert" : "status"}>{notice.message}</p>}
    {overview && !overview.resetCommands.length && <p>No fingerprint resets have been requested.</p>}
    {overview?.resetCommands.length ? <section className="ui-form" aria-labelledby="fingerprint-reset-status-title"><h3 id="fingerprint-reset-status-title">Fingerprint reset status</h3><p>Offline kiosks can continue using old associations until they reconnect. Acknowledgement confirms durable local mapping removal, not reader erasure.</p><ul>{overview.resetCommands.map(command => <li key={command.id}>{command.kioskName}: {command.acknowledgedAt !== null ? "Completed" : command.currentPairing ? "Pending - waiting for kiosk" : "Previous pairing - no longer authorized"}</li>)}</ul></section> : null}
    {resetOpen && <ResetDialog resetId={resetId.current} onClose={() => setResetOpen(false)} onReset={onReset} />}
  </article>;
}
