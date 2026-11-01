// Pairing: the one-time code from the Kiosks page, then the device's settings PIN, typed twice.
import { useEffect, useState, type FormEvent } from "react";
import { formatPairingCode, normalizePairingCode, pairingCodeAlphabet } from "../../../../packages/shared/src/pairing-code.mjs";
import { pairWebKiosk } from "./kiosk-api.ts";
import { pairingCodeCharacters, pairingCodeFromHash, pairingCodeProblem, pairingErrorMessage } from "./kiosk-flow.ts";
import type { KioskStore, StoredPairing } from "./kiosk-store.ts";
import { Keyboard, usePhysicalKeys } from "./on-screen-keys.tsx";
import { CenteredMessage, KioskFrame, type Brand } from "./kiosk-parts.tsx";
import { ChooseSettingsPin } from "./settings-pin-screens.tsx";

/** Reads `#code=` from the address once, then removes it so the code doesn't stay in the address bar or history. */
function takeCodeFromAddress() {
  const code = pairingCodeFromHash(window.location.hash);
  if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  return code ?? "";
}

const pairingBrand: Brand = { organizationName: "LancerLogin" };

export function PairingScreen({ baseUrl, store, notice, onPaired }: { baseUrl: string; store: KioskStore; notice?: string; onPaired: (pairing: StoredPairing) => void }) {
  const [code, setCode] = useState(() => takeCodeFromAddress());
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState<StoredPairing>();
  useEffect(() => { document.title = "Pair kiosk · LancerLogin"; }, []);
  // A QR code scanned into a tab that already shows this screen changes only the address's #code=, without a reload.
  useEffect(() => { const taken = () => { const next = takeCodeFromAddress(); if (next) { setCode(next); setError(""); } }; window.addEventListener("hashchange", taken); return () => window.removeEventListener("hashchange", taken); }, []);

  async function pair(event?: FormEvent) {
    event?.preventDefault(); if (busy) return;
    const problem = pairingCodeProblem(code); if (problem) { setError(problem); return; }
    setBusy(true); setError("");
    try {
      const result = await pairWebKiosk({ baseUrl }, normalizePairingCode(code));
      const pairing: StoredPairing = { kioskId: result.kioskId, kioskToken: result.kioskToken, pairingId: result.pairingId, name: result.name };
      // The code is spent now, so the credential is saved before the PIN step: a reload mustn't lose the pairing.
      await store.save(pairing);
      void navigator.storage?.persist?.().catch(() => false);
      setPaired(pairing);
    } catch (failure) { setError(pairingErrorMessage(failure)); }
    finally { setBusy(false); }
  }

  const typeKey = (key: string) => { setError(""); setCode((current) => normalizePairingCode(current).length < 8 ? normalizePairingCode(current) + key : current); };
  const backspace = () => setCode((current) => normalizePairingCode(current).slice(0, -1));
  // Off while the settings PIN is chosen: the PIN pad takes the keyboard then.
  usePhysicalKeys("pairing", paired ? {} : { onCharacter: typeKey, onBackspace: backspace, onEnter: () => void pair() });

  if (paired) return <KioskFrame brand={pairingBrand} footerName={paired.name} footerStatus="Paired">
    <ChooseSettingsPin intro={`Paired as ${paired.name}.`} onChosen={async (settingsPin) => { const next = { ...paired, settingsPin }; await store.save(next); onPaired(next); }} />
  </KioskFrame>;

  const typed = normalizePairingCode(code);
  return <KioskFrame brand={pairingBrand} footerStatus="Not paired">
    <form className="wk-pairing" onSubmit={pair}>
      <CenteredMessage title="Pair this kiosk" detail="Enter the code from Kiosks > Add kiosk > Web kiosk on the dashboard." />
      {notice && <p className="wk-note wk-note-warning" role="status">{notice}</p>}
      <label className="wk-field-label" htmlFor="wk-pairing-code">Pairing code</label>
      <input id="wk-pairing-code" className="wk-entry wk-entry-code" value={typed.length === 8 ? formatPairingCode(typed) : code} inputMode="none" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="K7Q2-M9XD" maxLength={12}
        aria-invalid={error ? true : undefined} aria-describedby={error ? "wk-pairing-error" : undefined} onChange={(event) => { setCode(pairingCodeCharacters(event.target.value).slice(0, 8)); setError(""); }} />
      {error && <p id="wk-pairing-error" className="wk-note wk-note-error" role="alert">{error}</p>}
      <Keyboard symbols={false} characters={pairingCodeAlphabet} onKey={typeKey} onBackspace={backspace} onClear={() => setCode("")} onEnter={() => void pair()} enterLabel={busy ? "Pairing…" : "Pair"} enterDisabled={busy} />
    </form>
  </KioskFrame>;
}
