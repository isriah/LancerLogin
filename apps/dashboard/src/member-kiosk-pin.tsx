import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import "./kiosk-pins.css";

export type MemberPin = { set: boolean; setAt: string | null; setKioskName: string | null; failedAttempts: number; lockedUntil: string | null };
type Notice = { message: string; tone: "success" | "error" };

const sameDay = (left: Date, right: Date) => left.toDateString() === right.toDateString();
/** "4:15 PM", with the date in front when the lock ends on another day. */
export function lockedUntilText(value: string, now = new Date()) {
  const until = new Date(value), time = until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay(until, now) ? time : `${until.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
function setText(pin: MemberPin) {
  if (!pin.setAt) return "Unknown";
  const date = new Date(pin.setAt);
  const day = date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
  return pin.setKioskName ? `${day} at ${pin.setKioskName}` : day;
}

/** Roster > member > Kiosk PIN, for Admins and Operators. The PIN itself is never shown or returned. */
export function MemberKioskPin({ rosterId, memberName }: { rosterId: string; memberName: string }) {
  const [pin, setPin] = useState<MemberPin>();
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const path = `/admin/members/${encodeURIComponent(rosterId)}/pin`;
  async function load() { const result = await api<{ pin: MemberPin }>(path); setPin(result.pin); setLoadError(""); }
  useEffect(() => {
    let current = true; setPin(undefined); setNotice(undefined); setLoadError("");
    api<{ pin: MemberPin }>(path).then((result) => { if (current) setPin(result.pin); }, (error: Error) => { if (current) setLoadError(error.message); });
    return () => { current = false; };
  }, [path]);

  const locked = Boolean(pin?.lockedUntil && Date.parse(pin.lockedUntil) > Date.now());
  async function act(action: "reset" | "unlock") {
    if (busy || !pin) return;
    if (action === "reset" && !window.confirm(`Reset ${memberName}'s PIN? They'll set a new one at a kiosk with an Operator's approval.`)) return;
    setBusy(true); setNotice(undefined);
    try {
      await api(action === "reset" ? path : `${path}/unlock`, action === "reset" ? { method: "DELETE" } : { method: "POST", body: JSON.stringify({}) });
      setNotice({ tone: "success", message: action === "reset" ? `PIN reset. ${memberName} sets a new one at a kiosk with an Operator's approval.` : `PIN unlocked. ${memberName} can try again now.` });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    try { await load(); } catch (error) { setLoadError((error as Error).message); }
    finally { setBusy(false); }
  }

  const pill = !pin ? undefined : locked ? { tone: "error", text: `Locked until ${lockedUntilText(pin.lockedUntil!)}` } : pin.set ? { tone: "success", text: "PIN set" } : { tone: "neutral", text: "No PIN" };
  return <section className="task-card ui-card member-kiosk-pin" aria-labelledby="member-kiosk-pin-title">
    <div className="kiosk-pin-card-heading"><h2 id="member-kiosk-pin-title">Kiosk PIN</h2>{pill && <span className="status-pill ui-status" data-tone={pill.tone}>{pill.text}</span>}</div>
    {!pin && !loadError && <p className="kiosk-pin-hint" role="status">Loading kiosk PIN…</p>}
    {loadError && <p className="ui-status" data-tone="error" role="alert">{loadError}</p>}
    {pin && <>
      {pin.set ? <dl className="kiosk-pin-facts"><div><dt>Set</dt><dd>{setText(pin)}</dd></div><div><dt>Wrong tries</dt><dd>{pin.failedAttempts}</dd></div></dl>
        : <p className="kiosk-pin-hint">No PIN yet. The member sets one at a kiosk that requires a PIN, with an Operator's approval.</p>}
      {(pin.set || locked) && <div className="kiosk-pin-actions" role="group" aria-label="Kiosk PIN actions">
        {locked && <button className="ui-button ui-button--primary" type="button" disabled={busy} onClick={() => void act("unlock")}>Unlock</button>}
        {pin.set && <button className="ui-button ui-button--danger" type="button" disabled={busy} onClick={() => void act("reset")}>Reset PIN</button>}
      </div>}
      {pin.set && <p className="kiosk-pin-hint">After a reset, the member sets a new PIN at a kiosk with an Operator's approval.</p>}
    </>}
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
  </section>;
}
