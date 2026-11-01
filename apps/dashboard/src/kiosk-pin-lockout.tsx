import { FormEvent, useEffect, useState } from "react";
import { api } from "./dashboard-api";
import "./kiosk-pins.css";

export type PinLockout = { enabled: boolean; attempts: number; minutes: number };
type Notice = { message: string; tone: "success" | "error" };

const wholeNumber = (value: string) => /^\d+$/.test(value.trim()) ? Number(value) : NaN;
export function lockoutErrors(attempts: string, minutes: string) {
  const tries = wholeNumber(attempts), lock = wholeNumber(minutes);
  return {
    attempts: tries >= 3 && tries <= 20 ? "" : "Wrong tries must be a whole number from 3 to 20.",
    minutes: lock >= 1 && lock <= 1440 ? "" : "Lock for must be a whole number of minutes from 1 to 1440.",
  };
}

/** Settings > Configuration > Kiosk PIN lockout, for Admins. Off by default. */
export function KioskPinLockoutSettings() {
  const [saved, setSaved] = useState<PinLockout>();
  const [enabled, setEnabled] = useState(false);
  const [attempts, setAttempts] = useState("5");
  const [minutes, setMinutes] = useState("15");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  function apply(settings: PinLockout) { setSaved(settings); setEnabled(settings.enabled); setAttempts(String(settings.attempts)); setMinutes(String(settings.minutes)); }
  useEffect(() => {
    let current = true;
    api<PinLockout>("/admin/settings/pin-lockout").then((settings) => { if (current) apply(settings); }, (error: Error) => { if (current) setLoadError(error.message); });
    return () => { current = false; };
  }, []);

  // Turned off, the numbers are kept but not checked; invalid ones fall back to the saved values.
  const errors = enabled ? lockoutErrors(attempts, minutes) : { attempts: "", minutes: "" };
  const visibleErrors = showErrors ? errors : { attempts: "", minutes: "" };
  async function save(event: FormEvent) {
    event.preventDefault(); if (!saved || saving) return;
    if (errors.attempts || errors.minutes) { setShowErrors(true); setNotice(undefined); return; }
    const valid = lockoutErrors(attempts, minutes);
    const next: PinLockout = { enabled, attempts: valid.attempts ? saved.attempts : Number(attempts), minutes: valid.minutes ? saved.minutes : Number(minutes) };
    setSaving(true); setNotice(undefined);
    try {
      const result = await api<Partial<PinLockout>>("/admin/settings/pin-lockout", { method: "PUT", body: JSON.stringify(next) });
      apply(typeof result.enabled === "boolean" ? result as PinLockout : next); setShowErrors(false);
      setNotice({ tone: "success", message: next.enabled ? `Kiosk PIN lockout saved. A PIN locks for ${next.minutes} ${next.minutes === 1 ? "minute" : "minutes"} after ${next.attempts} wrong tries.` : "Kiosk PIN lockout saved. It is off." });
    } catch (error) { setNotice({ tone: "error", message: (error as Error).message }); }
    finally { setSaving(false); }
  }

  const disabled = !saved || saving;
  return <section className="ui-card kiosk-pin-lockout" aria-labelledby="kiosk-pin-lockout-title">
    <div className="kiosk-pin-card-heading"><h2 id="kiosk-pin-lockout-title">Kiosk PIN lockout</h2>{saved && <span className="status-pill ui-status" data-tone={saved.enabled ? "success" : "neutral"}>{saved.enabled ? "On" : "Off"}</span>}</div>
    {loadError && <p className="ui-status" data-tone="error" role="alert">{loadError}</p>}
    <form className="kiosk-pin-lockout-form ui-form" noValidate onSubmit={(event) => void save(event)}>
      <label className="checkbox-field kiosk-pin-checkbox"><input className="ui-checkbox" type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => { setEnabled(event.target.checked); setShowErrors(false); }} /><span>Lock a member's PIN after repeated wrong tries</span></label>
      <div className="kiosk-pin-lockout-fields">
        <div className="kiosk-pin-number"><label htmlFor="kiosk-pin-lockout-attempts">Wrong tries</label><input id="kiosk-pin-lockout-attempts" type="number" inputMode="numeric" min={3} max={20} step={1} value={attempts} disabled={disabled || !enabled} aria-invalid={Boolean(visibleErrors.attempts)} aria-describedby={visibleErrors.attempts ? "kiosk-pin-lockout-attempts-error" : undefined} onChange={(event) => setAttempts(event.target.value)} />{visibleErrors.attempts && <span className="inline-field-error" id="kiosk-pin-lockout-attempts-error" role="alert">{visibleErrors.attempts}</span>}</div>
        <div className="kiosk-pin-number"><label htmlFor="kiosk-pin-lockout-minutes">Lock for (minutes)</label><input id="kiosk-pin-lockout-minutes" type="number" inputMode="numeric" min={1} max={1440} step={1} value={minutes} disabled={disabled || !enabled} aria-invalid={Boolean(visibleErrors.minutes)} aria-describedby={visibleErrors.minutes ? "kiosk-pin-lockout-minutes-error" : undefined} onChange={(event) => setMinutes(event.target.value)} />{visibleErrors.minutes && <span className="inline-field-error" id="kiosk-pin-lockout-minutes-error" role="alert">{visibleErrors.minutes}</span>}</div>
      </div>
      <p className="kiosk-pin-hint">Off by default. Applies to every kiosk that requires a PIN. Wrong tries made offline count once the kiosk syncs.</p>
      <button className="ui-button ui-button--primary" type="submit" disabled={disabled}>{saving ? "Saving…" : "Save"}</button>
    </form>
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
  </section>;
}
