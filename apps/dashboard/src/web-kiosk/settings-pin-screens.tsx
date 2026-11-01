// Choosing the settings PIN (typed twice) and entering it to open maintenance.
import { useState } from "react";
import { hashSettingsPin, verifySettingsPin, type SettingsPinHash } from "./settings-pin.ts";
import { settingsPinProblem } from "./kiosk-flow.ts";
import { PinPad } from "./kiosk-parts.tsx";

export function ChooseSettingsPin({ intro, onChosen, onCancel }: { intro?: string; onChosen: (hash: SettingsPinHash) => Promise<void> | void; onCancel?: () => void }) {
  const [first, setFirst] = useState<string>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(pin: string) {
    if (first === undefined) {
      const problem = settingsPinProblem(pin, pin); if (problem) { setError(problem); return; }
      setFirst(pin); setError(""); return;
    }
    const problem = settingsPinProblem(first, pin);
    if (problem) { setFirst(undefined); setError(problem); return; }
    setBusy(true);
    try { await onChosen(await hashSettingsPin(pin)); }
    catch { setFirst(undefined); setError("The PIN couldn't be saved. Try again."); }
    finally { setBusy(false); }
  }
  return first === undefined
    ? <PinPad key="first" title="Choose a settings PIN" detail={`${intro ? `${intro} ` : ""}6 to 12 digits. It opens this kiosk's maintenance screen.`} error={error} onSubmit={(pin) => void submit(pin)} onCancel={onCancel} submitLabel="Next" />
    : <PinPad key="second" title="Type the PIN again" detail="To make sure it's right." error={error} onSubmit={(pin) => void submit(pin)} onCancel={onCancel} submitLabel={busy ? "Saving…" : "Save"} busy={busy} />;
}

export function EnterSettingsPin({ stored, onVerified, onCancel }: { stored: SettingsPinHash; onVerified: () => void; onCancel: () => void }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(pin: string) {
    setBusy(true); setError("");
    try { if (await verifySettingsPin(pin, stored)) onVerified(); else setError("That PIN isn't right."); }
    catch { setError("The PIN couldn't be checked. Try again."); }
    finally { setBusy(false); }
  }
  return <PinPad title="Settings PIN" detail="Enter this kiosk's settings PIN." error={error} onSubmit={(pin) => void submit(pin)} onCancel={onCancel} busy={busy} />;
}
