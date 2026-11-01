import { FormEvent, useId, useState } from "react";
import { PairingCodeError, RetireAndReplace, requestPairingCode } from "./kiosk-pairing-request";
import { QrCode } from "./qr-code";
import { formatPairingCode, normalizePairingCode } from "../../../packages/shared/src/pairing-code.mjs";

export type WebPairing = { code: string; displayCode?: string; expiresAt: string; kioskName: string; kind: "web" };
type Notice = { message: string; tone: "neutral" | "success" | "error" };


/** The address a web kiosk opens to pair. The code sits after `#`, so it never reaches server logs. */
export function webKioskPairingUrl(code: string, origin = window.location.origin) {
  return `${origin}/kiosk#code=${normalizePairingCode(code)}`;
}

/** Add kiosk > Web kiosk: name the device, create a one-time code, and show it with a QR code for the device's camera. */
export function WebKioskPairing({ busy, setBusy, setNotice, onCreated, onReplaced }: { busy: boolean; setBusy: (busy: boolean) => void; setNotice: (notice?: Notice) => void; onCreated: () => void; onReplaced: () => void }) {
  const id = useId();
  const [name, setName] = useState("New kiosk");
  const [pairing, setPairing] = useState<WebPairing>();
  const [replaceable, setReplaceable] = useState<{ kioskId: string; name: string; message: string }>();

  async function create(replaceKioskId?: string) {
    setBusy(true); setNotice(undefined); setReplaceable(undefined);
    const kioskName = name.trim();
    try {
      setPairing(await requestPairingCode<WebPairing>("/admin/pairing-codes", { kioskName, kind: "web", ...(replaceKioskId ? { replaceKioskId } : {}) })); onCreated();
      if (replaceKioskId) { setNotice({ message: `The old ${kioskName} was retired. Its attendance history stays.`, tone: "success" }); onReplaced(); }
    } catch (error) {
      setPairing(undefined);
      // A replaceable name shows its message in the Retire and replace callout; other refusals are a plain error.
      if (error instanceof PairingCodeError && error.replaceableKioskId) setReplaceable({ kioskId: error.replaceableKioskId, name: kioskName, message: error.message });
      else setNotice({ message: (error as Error).message, tone: "error" });
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void create(); }

  const url = pairing ? webKioskPairingUrl(pairing.code) : "";
  const displayCode = pairing ? pairing.displayCode ?? formatPairingCode(pairing.code) : "";
  return <div className="web-kiosk-pairing">
    <form className="kiosk-pairing-key-form" onSubmit={submit}>
      <label htmlFor={`${id}-name`}>Kiosk name</label>
      <input id={`${id}-name`} required maxLength={80} value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setReplaceable(undefined); }} />
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Creating…" : "Create pairing code"}</button>
    </form>
    {replaceable && <RetireAndReplace name={replaceable.name} message={replaceable.message} busy={busy} onReplace={() => void create(replaceable.kioskId)} />}
    {pairing && <div className="web-kiosk-code" aria-label="Web kiosk pairing code" role="group">
      <div className="web-kiosk-code-text">
        <p>On the device, open <a href={url} target="_blank" rel="noreferrer">{url}</a> or scan the QR code. To type it instead, open the kiosk page and enter:</p>
        <code className="web-kiosk-code-value">{displayCode}</code>
        <p>The code works once and expires in 10 minutes.</p>
      </div>
      <QrCode className="web-kiosk-qr" value={url} label={`QR code that opens the kiosk page with code ${displayCode}`} />
    </div>}
  </div>;
}
