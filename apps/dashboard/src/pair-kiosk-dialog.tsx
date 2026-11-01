import { FormEvent, useId, useRef, useState } from "react";
import { dashboardReleaseVersion, hardwarePairingKey, kioskInstallCommands } from "./hardware-pairing-key";
import { useModalFocus } from "./modal-focus";
import { PairingCodeError, RetireAndReplace, requestPairingCode } from "./kiosk-pairing-request";
import { WebKioskPairing } from "./web-kiosk-pairing";
import "./web-kiosk-admin.css";

type Pairing = { code: string; expiresAt: string; workerApiUrl: string; kioskName: string };
type Notice = { message: string; tone: "neutral" | "success" | "error" };

/** Add kiosk: a Raspberry Pi or a web kiosk. For a Pi: prepare the Pi, run the installer pinned to this dashboard's release, create a one-time key, and pair from the Pi's local page. */
export function PairKioskDialog({ onClose, onPaired }: { onClose: () => void; onPaired: () => Promise<void> }) {
  const id = useId();
  const [name, setName] = useState("New kiosk");
  const [kind, setKind] = useState<"pi" | "web">("pi");
  const [fingerprintReader, setFingerprintReader] = useState(true);
  const [replaceable, setReplaceable] = useState<{ kioskId: string; name: string; message: string }>();
  const [webCreated, setWebCreated] = useState(false);
  const [pairing, setPairing] = useState<Pairing>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true, busy, onClose);

  // A name held by a kiosk that stopped checking in can be retired and replaced; the old kiosk's history stays.
  async function generate(event?: FormEvent, replaceKioskId?: string) {
    event?.preventDefault(); setBusy(true); setNotice(undefined); setReplaceable(undefined);
    try {
      setPairing(await requestPairingCode<Pairing>("/admin/pairing-codes", { kioskName: name, purpose: "hardware", ...(replaceKioskId ? { replaceKioskId } : {}) }));
      if (replaceKioskId) { setNotice({ message: `The old ${name.trim()} was retired. Its attendance history stays.`, tone: "success" }); void onPaired(); }
    }
    catch (error) { if (error instanceof PairingCodeError && error.replaceableKioskId) setReplaceable({ kioskId: error.replaceableKioskId, name: name.trim(), message: error.message }); else setNotice({ message: (error as Error).message, tone: "error" }); }
    finally { setBusy(false); }
  }
  function copy(text: string, label: string) {
    void navigator.clipboard.writeText(text).then(() => setNotice({ message: `${label} copied.`, tone: "success" }), () => setNotice({ message: `Select and copy the ${label.toLowerCase()} manually.`, tone: "error" }));
  }

  const commands = kioskInstallCommands(fingerprintReader);
  const key = pairing ? hardwarePairingKey(pairing.workerApiUrl, pairing.code, pairing.kioskName) : "";
  return <div className="dialog-backdrop"><div className="kiosk-pairing-dialog ui-dialog" role="dialog" aria-modal="true" aria-labelledby="pair-kiosk-title" aria-describedby="pair-kiosk-description" tabIndex={-1} ref={dialog}>
    <div className="kiosk-pairing-body">
      <div className="dialog-heading"><div><h2 id="pair-kiosk-title">Add kiosk</h2><p id="pair-kiosk-description">{kind === "web" ? "Pair a touchscreen laptop or tablet that runs the kiosk page in its browser, without interrupting any existing kiosk." : "Install the kiosk software on a Raspberry Pi, then pair it without interrupting any existing kiosk."}</p></div><button type="button" aria-label="Close pairing dialog" disabled={busy} onClick={onClose}>×</button></div>
      <fieldset className="kiosk-kind-choice"><legend>Kind of kiosk</legend>
        <label><input type="radio" name={`${id}-kind`} aria-labelledby={`${id}-kind-pi`} aria-describedby={`${id}-kind-pi-detail`} checked={kind === "pi"} disabled={busy} onChange={() => { setKind("pi"); setNotice(undefined); }} /><span><strong id={`${id}-kind-pi`}>Raspberry Pi kiosk</strong><small id={`${id}-kind-pi-detail`}>Fingerprint reader. Paired with a one-time pairing key.</small></span></label>
        <label><input type="radio" name={`${id}-kind`} aria-labelledby={`${id}-kind-web`} aria-describedby={`${id}-kind-web-detail`} checked={kind === "web"} disabled={busy} onChange={() => { setKind("web"); setWebCreated(false); setNotice(undefined); }} /><span><strong id={`${id}-kind-web`}>Web kiosk</strong><small id={`${id}-kind-web-detail`}>Any touchscreen laptop or tablet. Open the kiosk page on the device and enter the code below.</small></span></label>
      </fieldset>
      {kind === "web" ? <WebKioskPairing busy={busy} setBusy={setBusy} setNotice={setNotice} onCreated={() => setWebCreated(true)} onReplaced={() => void onPaired()} /> : <ol className="kiosk-pairing-steps">
        <li><h3>Prepare the Pi</h3><ul><li>Install Raspberry Pi OS with desktop and connect the Pi to the same network as this dashboard.</li><li>Make sure Node.js 18 or newer is installed at <code>/usr/bin/node</code> and that the Pi uses NetworkManager, the default on current Raspberry Pi OS.</li><li>For an R503 fingerprint reader, enable the serial port with <code>sudo raspi-config</code> (Interface Options, Serial Port: login shell off, serial hardware on) so <code>/dev/serial0</code> exists.</li></ul>
          <fieldset className="kiosk-pairing-reader"><legend>Fingerprint reader</legend><label><input type="radio" name={`${id}-reader`} checked={fingerprintReader} onChange={() => setFingerprintReader(true)} /> This kiosk has an R503 fingerprint reader</label><label><input type="radio" name={`${id}-reader`} checked={!fingerprintReader} onChange={() => setFingerprintReader(false)} /> No fingerprint reader (badge, QR code, or member ID entry)</label></fieldset></li>
        <li><h3>Install the kiosk software</h3><p>On the Pi, open Terminal and run these commands. The dry run shows what will change without changing anything. The installer matches this dashboard, release {dashboardReleaseVersion}.</p><pre className="kiosk-pairing-command" tabIndex={0} aria-label="Install commands"><code>{commands}</code></pre><button className="ui-button" type="button" onClick={() => copy(commands, "Install commands")}>Copy install commands</button></li>
        <li><h3>Create the one-time pairing key</h3><form className="kiosk-pairing-key-form" onSubmit={generate}><label htmlFor={`${id}-name`}>Kiosk name</label><input id={`${id}-name`} required maxLength={80} value={name} onChange={(event) => { setName(event.target.value); setReplaceable(undefined); }} /><button className="primary-button" type="submit" disabled={busy}>{busy ? "Creating…" : "Create one-time pairing key"}</button></form>
          {replaceable && <RetireAndReplace name={replaceable.name} message={replaceable.message} busy={busy} onReplace={() => void generate(undefined, replaceable.kioskId)} />}
          {pairing && <div className="pairing-key"><span>Pairing key</span><code>{key}</code><small>Expires {new Date(pairing.expiresAt).toLocaleString()}.</small><button type="button" onClick={() => copy(key, "Pairing key")}>Copy pairing key</button></div>}</li>
        <li><h3>Pair from a phone or laptop</h3><p>On a phone or laptop on the same network, open <code>http://&lt;pi-hostname&gt;.local:8788</code>. The installer prints this address and an IP address to use if it does not open. Paste the pairing key, enter the six-digit setup code shown on the kiosk screen, and choose Pair kiosk.</p></li>
      </ol>}
      {notice && <p className="inline-messages ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Close</button>{(kind === "web" ? webCreated : pairing) && <button className="primary-button" type="button" onClick={() => void onPaired().then(onClose)}>Refresh kiosk status</button>}</div>
    </div>
  </div></div>;
}
