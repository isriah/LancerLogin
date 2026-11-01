import { useState } from "react";
import { PairingCodeError, requestPairingCode } from "./kiosk-pairing-request";
import { webKioskPairingUrl, type WebPairing } from "./web-kiosk-pairing";

const deviceIdKey = "lancerlogin.debugKioskDevice";
const deviceIdPattern = /^[A-Z0-9]{4}$/;

function randomDeviceId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (value) => alphabet[value % alphabet.length]).join("");
}

/** A short id for this browser, kept so the debug kiosk it opens keeps its name and a stale one is replaced, not duplicated. */
export function debugDeviceId(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(deviceIdKey);
    if (saved && deviceIdPattern.test(saved)) return saved;
    const id = randomDeviceId(); storage?.setItem(deviceIdKey, id); return id;
  } catch { return randomDeviceId(); }
}

/**
 * Debug tools > Open web kiosk on this device: creates a web kiosk code named after this browser and opens the kiosk
 * page with it in a new tab, so an Admin can try the web kiosk without a second device. A debug kiosk from this browser
 * that stopped checking in is retired and replaced; its history stays.
 */
export function OpenWebKioskOnThisDevice({ onPaired }: { onPaired?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone: "success" | "error" }>();

  async function open() {
    setBusy(true); setNotice(undefined);
    // Opened before the request, while the click still counts, so a popup blocker lets it through.
    const tab = window.open("about:blank", "_blank");
    const kioskName = `Debug kiosk ${debugDeviceId()}`;
    try {
      let pairing: WebPairing;
      try { pairing = await requestPairingCode<WebPairing>("/admin/pairing-codes", { kioskName, kind: "web" }); }
      catch (error) {
        if (!(error instanceof PairingCodeError && error.replaceableKioskId)) throw error;
        pairing = await requestPairingCode<WebPairing>("/admin/pairing-codes", { kioskName, kind: "web", replaceKioskId: error.replaceableKioskId });
      }
      const url = webKioskPairingUrl(pairing.code);
      if (tab) { tab.opener = null; tab.location.href = url; } else window.open(url, "_blank", "noopener");
      setNotice({ message: `${kioskName} opened in a new tab. It pairs on its own and appears in the kiosk list once it checks in.`, tone: "success" });
      onPaired?.();
    } catch (error) {
      tab?.close();
      const inUse = error instanceof PairingCodeError && error.code === "kiosk_name_in_use";
      setNotice({ message: inUse ? `${kioskName} is already paired and checking in. Use its open tab, or retire it first.` : (error as Error).message, tone: "error" });
    } finally { setBusy(false); }
  }

  return <section className="task-card kiosk-debug-web-kiosk" aria-labelledby="kiosk-debug-web-kiosk-title">
    <div className="panel-heading"><div><h3 id="kiosk-debug-web-kiosk-title">Open web kiosk on this device</h3><p>Pairs a web kiosk named after this browser and opens it in a new tab, to try the kiosk without a second device. Its check-ins are real attendance, so use synthetic test members.</p></div>
      <button className="ui-button" type="button" disabled={busy} onClick={() => void open()}>{busy ? "Opening…" : "Open web kiosk on this device"}</button></div>
    {notice && <p className="ui-status" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p>}
  </section>;
}
