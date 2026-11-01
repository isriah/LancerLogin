// The kiosk's frame (brand row, main area, footer), the settings PIN pad and the result screen.
import { useRef, useState, type ReactNode } from "react";
import type { KioskDisplay } from "../../../kiosk/src/kiosk-presentation.mjs";
import { settingsPinMaxLength } from "./settings-pin.ts";
import { Keypad, usePhysicalKeys } from "./on-screen-keys.tsx";
import { maintenanceHoldMs } from "./kiosk-flow.ts";

export type Brand = { organizationName: string; logoData?: string };

/** The organization name; holding it for 3 seconds calls onHold (maintenance). */
function BrandRow({ brand, onHold }: { brand: Brand; onHold?: () => void }) {
  const timer = useRef<number | undefined>(undefined); const [holding, setHolding] = useState(false);
  const cancel = () => { window.clearTimeout(timer.current); timer.current = undefined; setHolding(false); };
  const start = () => { if (!onHold) return; cancel(); setHolding(true); timer.current = window.setTimeout(() => { cancel(); onHold(); }, maintenanceHoldMs); };
  const initial = brand.organizationName.trim().charAt(0).toUpperCase() || "L";
  return <header className="wk-brand">
    <div className={`wk-brand-hold${holding ? " wk-holding" : ""}`} data-testid="wk-brand-hold" onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel} onContextMenu={(event) => event.preventDefault()}>
      {brand.logoData ? <img className="wk-logo" src={brand.logoData} alt="" draggable={false} /> : <span className="wk-mark" aria-hidden="true">{initial}</span>}
      <strong>{brand.organizationName}</strong>
    </div>
  </header>;
}

export function KioskFrame({ brand, onHold, footerName, footerStatus, online, children }: { brand: Brand; onHold?: () => void; footerName?: string; footerStatus?: ReactNode; online?: boolean; children: ReactNode }) {
  return <div className="wk-screen">
    <BrandRow brand={brand} onHold={onHold} />
    <main className="wk-body">{children}</main>
    <footer className="wk-foot">
      <span>{footerName && <><span className={`wk-dot${online === false ? " wk-dot-off" : ""}`} aria-hidden="true" />{footerName}</>}</span>
      <span aria-live="polite">{footerStatus}</span>
    </footer>
  </div>;
}

/**
 * Dots for a PIN being typed, and the keypad. The PIN itself is never shown. `minLength` digits enable Enter and set
 * how many dots show at first. With `cancelOnKeypad` (member PINs, as in the mockup) the keypad's Clear key reads
 * Cancel until a digit is typed, instead of a separate Cancel button.
 */
export function PinPad({ title, detail, error, note, onSubmit, onCancel, submitLabel = "Enter", busy, minLength = 1, maxLength = settingsPinMaxLength, dots = 6, cancelOnKeypad }: {
  title: string; detail?: string; error?: string; note?: ReactNode; onSubmit: (pin: string) => void; onCancel?: () => void; submitLabel?: string; busy?: boolean;
  minLength?: number; maxLength?: number; dots?: number; cancelOnKeypad?: boolean;
}) {
  const [pin, setPin] = useState("");
  const type = (digit: string) => setPin((current) => current.length < maxLength ? current + digit : current);
  const submit = () => { if (busy || pin.length < minLength) return; const value = pin; setPin(""); onSubmit(value); };
  usePhysicalKeys("digits", { onCharacter: type, onBackspace: () => setPin((current) => current.slice(0, -1)), onEnter: submit, onEscape: onCancel });
  const keypadCancels = Boolean(cancelOnKeypad && onCancel && !pin);
  return <div className="wk-split">
    <div className="wk-split-left">
      <h1 className="wk-title">{title}</h1>
      {detail && <p className="wk-sub">{detail}</p>}
      <div className="wk-pins" role="img" aria-label={`${pin.length} digits entered`}>{Array.from({ length: Math.max(dots, pin.length) }, (_, index) => <span key={index} className={index < pin.length ? "wk-pin-on" : ""} />)}</div>
      {error && <p className="wk-note wk-note-error" role="alert">{error}</p>}
      {note}
      {onCancel && !cancelOnKeypad && <button type="button" className="wk-button" onClick={onCancel}>Cancel</button>}
    </div>
    <Keypad onDigit={type} clearLabel={keypadCancels ? "Cancel" : "Clear"} onClear={() => keypadCancels ? onCancel!() : setPin("")} enterLabel={submitLabel} enterDisabled={busy || pin.length < minLength} onEnter={submit} />
  </div>;
}

export function ResultView({ display }: { display: KioskDisplay }) {
  const detail = [display.detail, display.meetingTitle].filter(Boolean).join(" · ");
  return <div className="wk-result" data-tone={display.tone} data-state={display.id} role="status">
    <div className={`wk-ring wk-ring-${display.tone}`} aria-hidden="true" />
    <h1 className="wk-title">{display.message}</h1>
    {display.name && <p className="wk-result-name">{display.name}</p>}
    {detail && <p className={display.tone === "success" ? "wk-meeting" : "wk-sub"}>{detail}</p>}
  </div>;
}

export function CenteredMessage({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return <div className="wk-centered"><h1 className="wk-title">{title}</h1>{detail && <p className="wk-sub">{detail}</p>}{children}</div>;
}
